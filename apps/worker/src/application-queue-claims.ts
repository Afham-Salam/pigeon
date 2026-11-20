const CLAIM_TTL_MS = 30 * 60 * 1000;

export async function claimApplicationCreation(
  db: D1Database,
  jobId: string,
  nowMs = Date.now(),
): Promise<string | null> {
  const claimToken = crypto.randomUUID();
  const claimedAt = new Date(nowMs).toISOString();
  const expiredBefore = new Date(nowMs - CLAIM_TTL_MS).toISOString();
  const result = await db
    .prepare(
      `INSERT INTO application_queue_claims (job_id, claim_token, claimed_at)
       VALUES (?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         claim_token = excluded.claim_token,
         claimed_at = excluded.claimed_at
       WHERE application_queue_claims.claimed_at < ?`,
    )
    .bind(jobId, claimToken, claimedAt, expiredBefore)
    .run();

  return result.meta.changes === 1 ? claimToken : null;
}

export async function releaseApplicationCreationClaim(
  db: D1Database,
  jobId: string,
  claimToken: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM application_queue_claims WHERE job_id = ? AND claim_token = ?')
    .bind(jobId, claimToken)
    .run();
}
