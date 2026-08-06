CREATE TABLE IF NOT EXISTS brad_objectives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  session_key TEXT,
  goal TEXT NOT NULL,
  definition_of_done TEXT NOT NULL,
  verification_method TEXT NOT NULL,
  authority_level TEXT NOT NULL CHECK (authority_level IN ('READ_ONLY', 'APPROVAL_REQUIRED', 'OWNER_APPROVAL')),
  status TEXT NOT NULL CHECK (status IN ('INTAKED', 'RUNNING', 'WAITING', 'BLOCKED', 'SUCCEEDED', 'FAILED', 'CANCELLED')) DEFAULT 'INTAKED',
  current_step TEXT NOT NULL,
  next_action TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL,
  final_evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE(person_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS brad_objective_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  objective_id UUID NOT NULL REFERENCES brad_objectives(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  action_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('STARTED', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'RECONCILE_REQUIRED', 'WAITING_APPROVAL')),
  request_digest TEXT,
  provider_effect_id TEXT,
  output_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE(objective_id, attempt_no)
);

CREATE TABLE IF NOT EXISTS brad_objective_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  objective_id UUID NOT NULL REFERENCES brad_objectives(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  current_step TEXT NOT NULL,
  next_action TEXT NOT NULL,
  state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(objective_id, version)
);

ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS objective_id UUID REFERENCES brad_objectives(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payload_digest TEXT;

CREATE INDEX IF NOT EXISTS idx_brad_objectives_person_status
  ON brad_objectives(person_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_brad_objective_attempts_objective
  ON brad_objective_attempts(objective_id, attempt_no DESC);
CREATE INDEX IF NOT EXISTS idx_approval_requests_objective
  ON approval_requests(objective_id, status);
