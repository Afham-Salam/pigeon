import type { D1LikeDatabase } from '../state-machine.js';
import { isTrackableCompany, normalizeCompanyName } from '../sources/dedupe.js';

export interface SkippableJob {
  company: string;
  company_normalized?: string | undefined;
  contact_email?: string | null | undefined;
}

export interface SkipCheckResult {
  skipped: boolean;
  reason?: 'DNC' | 'RECENT_CONTACT' | undefined;
}

export interface SkipCheckCache {
  dncValues: Set<string>;
  companiesContacted: Map<string, string>;
}

/**
 * Preloads do_not_contact and companies_contacted once per pipeline run
 * to avoid up to 2 D1 queries per job inside the scoring loop.
 */
export async function loadSkipCheckCache(db: D1LikeDatabase): Promise<SkipCheckCache | undefined> {
  try {
    const [dncRes, contactedRes] = await Promise.all([
      db
        .prepare(`SELECT LOWER(value) as value FROM do_not_contact`)
        .bind()
        .all<{ value: string }>(),
      db
        .prepare(`SELECT company_normalized, last_contacted_at FROM companies_contacted`)
        .bind()
        .all<{ company_normalized: string; last_contacted_at: string }>(),
    ]);
    const dncValues = new Set<string>();
    for (const r of dncRes?.results ?? []) {
      if (r.value) dncValues.add(r.value.toLowerCase());
    }
    const companiesContacted = new Map<string, string>();
    for (const r of contactedRes?.results ?? []) {
      if (r.company_normalized && r.last_contacted_at) {
        companiesContacted.set(r.company_normalized.toLowerCase(), r.last_contacted_at);
      }
    }
    return { dncValues, companiesContacted };
  } catch {
    return undefined;
  }
}

/**
 * Step 2: Evaluates Do-Not-Contact and Recent Contact skip checks against D1.
 * - Contact email or domain in do_not_contact -> skipped, reason DNC
 * - Company in companies_contacted within 90 days -> skipped, reason RECENT_CONTACT
 */
export async function evaluateSkipChecks(
  job: SkippableJob,
  db: D1LikeDatabase,
  nowMs: number = Date.now(),
  cache?: SkipCheckCache,
): Promise<SkipCheckResult> {
  const compNorm = job.company_normalized || normalizeCompanyName(job.company);

  // 1. Check Do-Not-Contact table
  if (job.contact_email) {
    const email = job.contact_email.toLowerCase().trim();
    const atIndex = email.lastIndexOf('@');
    const domain = atIndex !== -1 ? email.slice(atIndex + 1) : '';

    if (cache) {
      if (cache.dncValues.has(email) || (domain && cache.dncValues.has(domain))) {
        return { skipped: true, reason: 'DNC' };
      }
    } else {
      const dncRow = await db
        .prepare(
          `SELECT value FROM do_not_contact WHERE LOWER(value) = ? OR LOWER(value) = ? LIMIT 1`,
        )
        .bind(email, domain)
        .first<{ value: string }>();

      if (dncRow) {
        return { skipped: true, reason: 'DNC' };
      }
    }
  }

  // 2. Check Companies Contacted within 90 days (skip untrackable placeholders like 'unknown')
  if (isTrackableCompany(compNorm)) {
    const lastContactedAt = cache
      ? cache.companiesContacted.get(compNorm.toLowerCase())
      : (
          await db
            .prepare(
              `SELECT company_normalized, last_contacted_at FROM companies_contacted WHERE company_normalized = ? LIMIT 1`,
            )
            .bind(compNorm)
            .first<{ company_normalized: string; last_contacted_at: string }>()
        )?.last_contacted_at;

    if (lastContactedAt) {
      const lastTime = new Date(lastContactedAt).getTime();
      const diffDays = (nowMs - lastTime) / (1000 * 60 * 60 * 24);

      if (diffDays < 90) {
        return { skipped: true, reason: 'RECENT_CONTACT' };
      }
    }
  }

  return { skipped: false };
}
