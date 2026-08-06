-- Linear is the human command board. Brad remains the durable execution ledger.
-- This migration is additive and safe to re-run.

ALTER TABLE brad_objectives
  ADD COLUMN IF NOT EXISTS source_system TEXT,
  ADD COLUMN IF NOT EXISTS source_external_id TEXT,
  ADD COLUMN IF NOT EXISTS source_external_url TEXT,
  ADD COLUMN IF NOT EXISTS assigned_worker TEXT,
  ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_brad_objectives_external_source
  ON brad_objectives (person_id, source_system, source_external_id)
  WHERE source_system IS NOT NULL AND source_external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS brad_linear_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  objective_id UUID NOT NULL REFERENCES brad_objectives(id) ON DELETE CASCADE,
  linear_issue_id TEXT NOT NULL,
  linear_identifier TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  state_id TEXT NOT NULL,
  state_name TEXT NOT NULL,
  state_type TEXT NOT NULL,
  team_id TEXT NOT NULL,
  priority INTEGER,
  labels_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  issue_url TEXT,
  source_updated_at TIMESTAMPTZ NOT NULL,
  payload_digest TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (person_id, linear_issue_id),
  UNIQUE (person_id, linear_identifier)
);

CREATE INDEX IF NOT EXISTS idx_brad_linear_issues_objective
  ON brad_linear_issues (objective_id);

CREATE TABLE IF NOT EXISTS brad_worker_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  objective_id UUID NOT NULL REFERENCES brad_objectives(id) ON DELETE CASCADE,
  worker_kind TEXT NOT NULL CHECK (worker_kind IN ('HERMES', 'OPENCLAW', 'KIMI_CLAW')),
  status TEXT NOT NULL CHECK (status IN (
    'QUEUED', 'LEASED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED',
    'RECONCILE_REQUIRED', 'CANCELLED'
  )) DEFAULT 'QUEUED',
  idempotency_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  contract_version INTEGER NOT NULL,
  input_json JSONB NOT NULL,
  skills_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts > 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT,
  lease_token UUID,
  leased_until TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_brad_worker_jobs_claim
  ON brad_worker_jobs (worker_kind, status, available_at, created_at);
CREATE INDEX IF NOT EXISTS idx_brad_worker_jobs_objective
  ON brad_worker_jobs (objective_id, created_at DESC);

CREATE TABLE IF NOT EXISTS brad_worker_job_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES brad_worker_jobs(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  lease_token UUID NOT NULL,
  worker_identity TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  skills_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('STARTED', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
  request_digest TEXT NOT NULL,
  provider_session_id TEXT,
  usage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  artifact_uri TEXT,
  artifact_sha256 TEXT,
  result_digest TEXT,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE (job_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS idx_brad_worker_job_attempts_job
  ON brad_worker_job_attempts (job_id, attempt_no DESC);

CREATE TABLE IF NOT EXISTS brad_worker_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES brad_worker_jobs(id) ON DELETE CASCADE,
  attempt_id UUID NOT NULL UNIQUE REFERENCES brad_worker_job_attempts(id) ON DELETE CASCADE,
  objective_id UUID NOT NULL REFERENCES brad_objectives(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('WORKER_SUCCEEDED', 'WORKER_FAILED')),
  verification_status TEXT NOT NULL CHECK (verification_status IN ('PENDING', 'VERIFIED', 'REJECTED')),
  result_digest TEXT,
  artifact_uri TEXT,
  artifact_sha256 TEXT,
  worker_identity TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  skills_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  usage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  verifier_kind TEXT,
  verifier_evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_brad_worker_receipts_objective
  ON brad_worker_receipts (objective_id, created_at DESC);

CREATE TABLE IF NOT EXISTS brad_projection_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  objective_id UUID REFERENCES brad_objectives(id) ON DELETE CASCADE,
  destination TEXT NOT NULL CHECK (destination IN ('LINEAR')),
  event_type TEXT NOT NULL CHECK (event_type IN ('COMMENT', 'SET_COMPLETED')),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'PENDING', 'LEASED', 'PROVIDER_SUBMITTED', 'SENT', 'FAILED', 'RECONCILE_REQUIRED'
  )) DEFAULT 'PENDING',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT,
  lease_token UUID,
  leased_until TIMESTAMPTZ,
  provider_effect_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_brad_projection_outbox_claim
  ON brad_projection_outbox (destination, status, available_at, created_at);
