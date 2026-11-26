-- Add indexes to eliminate full-table and quadratic scans on D1 free tier
CREATE INDEX IF NOT EXISTS idx_jobs_source_apply_url ON jobs (source, apply_url);
CREATE INDEX IF NOT EXISTS idx_jobs_status_fetched_at ON jobs (status, fetched_at);
CREATE INDEX IF NOT EXISTS idx_jobs_status_match_score ON jobs (status, match_score);
CREATE INDEX IF NOT EXISTS idx_jobs_status_updated_at ON jobs (status, updated_at);
CREATE INDEX IF NOT EXISTS idx_jobs_fetched_at ON jobs (fetched_at);
CREATE INDEX IF NOT EXISTS idx_jobs_apply_route ON jobs (apply_route);

CREATE INDEX IF NOT EXISTS idx_applications_job_id ON applications (job_id);
CREATE INDEX IF NOT EXISTS idx_applications_status_channel ON applications (status, channel);
CREATE INDEX IF NOT EXISTS idx_applications_synced_at ON applications (synced_at);
CREATE INDEX IF NOT EXISTS idx_applications_updated_at ON applications (updated_at);
CREATE INDEX IF NOT EXISTS idx_applications_sent_at ON applications (sent_at);

CREATE INDEX IF NOT EXISTS idx_events_type_created_at ON events (type, created_at);
