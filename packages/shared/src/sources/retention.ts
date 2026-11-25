import { logger } from '../logger.js';
import type { D1LikeDatabase } from '../state-machine.js';

export interface PurgeRetentionOptions {
  db: D1LikeDatabase;
  cutoffDays?: number;
  now?: Date;
}

export interface PurgeRetentionResult {
  purgedCount: number;
  cutoffDate: string;
}

export const PURGED_DESCRIPTION_PLACEHOLDER = '[Purged by retention policy]';

/**
 * Purges job descriptions older than `cutoffDays` (default 90) for jobs that were never applied to.
 * Preserves job descriptions, applications, cover letters, and events for all applied jobs.
 */
export async function purgeExpiredJobDescriptions(
  options: PurgeRetentionOptions,
): Promise<PurgeRetentionResult> {
  const { db, cutoffDays = 90, now = new Date() } = options;
  const cutoffTime = new Date(now.getTime() - cutoffDays * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoffTime.toISOString();
  const nowIso = now.toISOString();

  const result = await db
    .prepare(
      `UPDATE jobs
       SET description = ?, updated_at = ?
       WHERE fetched_at < ?
         AND id NOT IN (SELECT job_id FROM applications)
         AND description != ?`,
    )
    .bind(PURGED_DESCRIPTION_PLACEHOLDER, nowIso, cutoffIso, PURGED_DESCRIPTION_PLACEHOLDER)
    .run();

  const purgedCount = (result as { meta?: { changes?: number } })?.meta?.changes ?? 0;

  if (purgedCount > 0) {
    try {
      await db
        .prepare(
          `INSERT INTO events (id, entity, entity_id, type, payload, created_at)
           VALUES (?, 'retention', 'jobs', 'retention_purged', ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          JSON.stringify({
            purged_count: purgedCount,
            cutoff_days: cutoffDays,
            cutoff_date: cutoffIso,
          }),
          nowIso,
        )
        .run();
    } catch (err) {
      logger.error('Failed to write retention event to events table', err);
    }
  }

  return {
    purgedCount,
    cutoffDate: cutoffIso,
  };
}

export interface PurgeFilteredResult {
  deletedCount: number;
  cutoffDate: string;
}

/**
 * Deletes `filtered_out` jobs older than `cutoffDays` (default 14) that have no
 * linked applications, keeping D1 lean as general job boards accumulate TITLE_MISMATCH noise.
 */
export async function purgeOldFilteredJobs(
  options: PurgeRetentionOptions,
): Promise<PurgeFilteredResult> {
  const { db, cutoffDays = 14, now = new Date() } = options;
  const cutoffTime = new Date(now.getTime() - cutoffDays * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoffTime.toISOString();
  const nowIso = now.toISOString();

  const result = await db
    .prepare(
      `DELETE FROM jobs
       WHERE status = 'filtered_out'
         AND updated_at < ?
         AND id NOT IN (SELECT job_id FROM applications)`,
    )
    .bind(cutoffIso)
    .run();

  const deletedCount = (result as { meta?: { changes?: number } })?.meta?.changes ?? 0;

  if (deletedCount > 0) {
    try {
      await db
        .prepare(
          `INSERT INTO events (id, entity, entity_id, type, payload, created_at)
           VALUES (?, 'retention', 'jobs', 'retention_filtered_purged', ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          JSON.stringify({
            deleted_count: deletedCount,
            cutoff_days: cutoffDays,
            cutoff_date: cutoffIso,
          }),
          nowIso,
        )
        .run();
    } catch (err) {
      logger.error('Failed to write filtered retention event to events table', err);
    }
  }

  return {
    deletedCount,
    cutoffDate: cutoffIso,
  };
}
