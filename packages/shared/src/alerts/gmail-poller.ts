import type { D1LikeDatabase } from '../state-machine.js';
import type { Notifier } from '../notifier.js';
import type { GmailSender } from '../google/types.js';
import { ingestAlertEmail } from './ingest.js';

export interface PollGmailAlertsOptions {
  db: D1LikeDatabase;
  gmailSender: GmailSender;
  notifier?: Notifier | undefined;
  configuredForwardingAddress?: string | undefined;
  nowIso?: string | undefined;
  query?: string | undefined;
  maxMessages?: number | undefined;
}

export interface PollGmailAlertsResult {
  success: boolean;
  messagesFound: number;
  messagesProcessed: number;
  jobsFound: number;
  newJobs: number;
  duplicates: number;
  errors: number;
  reason?: string | undefined;
}

export const DEFAULT_GMAIL_ALERT_QUERY =
  'from:(whatjobs.com OR bebee.com OR linkedin.com OR indeed.com OR naukri.com OR wellfound.com OR otta.com OR ziprecruiter.com OR dice.com OR glassdoor.com OR instahyre.com OR foundit.in OR foundit.com) newer_than:7d';

/**
 * Polls Gmail for incoming job alert emails from supported portals,
 * parses each raw email, extracts jobs into D1, and records audit events.
 */
export async function pollGmailAlerts(
  options: PollGmailAlertsOptions,
): Promise<PollGmailAlertsResult> {
  const {
    db,
    gmailSender,
    notifier,
    configuredForwardingAddress,
    nowIso = new Date().toISOString(),
    query = DEFAULT_GMAIL_ALERT_QUERY,
    maxMessages = 20,
  } = options;

  if (typeof gmailSender.searchMessages !== 'function' || typeof gmailSender.getRawMessageBytes !== 'function') {
    return {
      success: false,
      messagesFound: 0,
      messagesProcessed: 0,
      jobsFound: 0,
      newJobs: 0,
      duplicates: 0,
      errors: 1,
      reason: 'gmailSender does not support searchMessages or getRawMessageBytes',
    };
  }

  let messages: Array<{ id: string; threadId: string }>;
  try {
    messages = await gmailSender.searchMessages(query, maxMessages);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      messagesFound: 0,
      messagesProcessed: 0,
      jobsFound: 0,
      newJobs: 0,
      duplicates: 0,
      errors: 1,
      reason: errorMsg,
    };
  }

  let messagesProcessed = 0;
  let totalJobsFound = 0;
  let totalNewJobs = 0;
  let totalDuplicates = 0;
  let errors = 0;

  for (const msg of messages) {
    try {
      // 1. Skip if already processed in events
      const existing = await db
        .prepare(`SELECT entity_id FROM events WHERE entity = ? AND entity_id = ?`)
        .bind('gmail_alert', msg.id)
        .first<{ entity_id: string }>();

      if (existing) {
        continue;
      }

      // 2. Fetch raw email bytes
      const rawBytes = await gmailSender.getRawMessageBytes(msg.id);
      if (!rawBytes || rawBytes.length === 0) {
        continue;
      }

      // 3. Ingest into Pigeon database
      const ingestRes = await ingestAlertEmail(rawBytes, {
        db,
        configuredForwardingAddress,
        notifier,
        nowIso,
      });

      // 4. Record event to avoid re-parsing
      const eventId = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO events (id, entity, entity_id, type, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          eventId,
          'gmail_alert',
          msg.id,
          'alert_polled',
          JSON.stringify({
            portal: ingestRes.portal,
            jobsFound: ingestRes.jobsFound,
            newJobs: ingestRes.newJobs,
            duplicates: ingestRes.duplicates,
            dropped: ingestRes.dropped,
            dropReason: ingestRes.dropReason,
          }),
          nowIso,
        )
        .run();

      messagesProcessed++;
      totalJobsFound += ingestRes.jobsFound;
      totalNewJobs += ingestRes.newJobs;
      totalDuplicates += ingestRes.duplicates;
    } catch (err) {
      errors++;
      console.warn(`[alerts] Error processing Gmail message ${msg.id}:`, err);
    }
  }

  return {
    success: true,
    messagesFound: messages.length,
    messagesProcessed,
    jobsFound: totalJobsFound,
    newJobs: totalNewJobs,
    duplicates: totalDuplicates,
    errors,
  };
}
