-- Pin the exact tool surface used by each autonomous worker job and receipt.
ALTER TABLE brad_worker_jobs
  ADD COLUMN IF NOT EXISTS toolsets_json JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE brad_worker_job_attempts
  ADD COLUMN IF NOT EXISTS toolsets_json JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE brad_worker_receipts
  ADD COLUMN IF NOT EXISTS toolsets_json JSONB NOT NULL DEFAULT '[]'::jsonb;
