-- Prevent overlapping scoring runs from enqueueing application creation twice.
-- Claims expire after 30 minutes so a crashed queue task can be re-enqueued.
CREATE TABLE IF NOT EXISTS application_queue_claims (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  claim_token TEXT NOT NULL,
  claimed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_application_queue_claims_claimed_at
  ON application_queue_claims (claimed_at);
