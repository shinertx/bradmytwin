-- Brad multi-agent conductor. Additive and shadow-safe by default.

CREATE TABLE IF NOT EXISTS brad_agent_registry (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'EXECUTIVE', 'OPERATOR', 'BUILDER', 'CRITIC', 'VERIFIER', 'SYSTEM')),
  adapter_kind TEXT NOT NULL CHECK (adapter_kind IN ('OWNER', 'OPENCLAW', 'HERMES', 'BUZZ_ACP', 'DETERMINISTIC', 'SYSTEM')),
  provider TEXT,
  model TEXT,
  capabilities_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  authority_ceiling TEXT NOT NULL CHECK (authority_ceiling IN ('READ_ONLY', 'INTERNAL_WRITE', 'APPROVAL_REQUIRED', 'OWNER_APPROVAL')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  health_status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (health_status IN ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNAVAILABLE')),
  version TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_health_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO brad_agent_registry (id, display_name, role, adapter_kind, authority_ceiling, capabilities_json)
VALUES
  ('owner', 'Ben', 'OWNER', 'OWNER', 'OWNER_APPROVAL', '["direction","approval"]'::jsonb),
  ('system', 'Brad Conductor', 'SYSTEM', 'SYSTEM', 'READ_ONLY', '["routing","recovery","loop_defense"]'::jsonb),
  ('brad-kimi', 'Brad', 'EXECUTIVE', 'OPENCLAW', 'APPROVAL_REQUIRED', '["reasoning","delegation","decision"]'::jsonb),
  ('hermes', 'Hermes', 'OPERATOR', 'HERMES', 'INTERNAL_WRITE', '["research","browser","evidence","bounded_operations"]'::jsonb),
  ('codex', 'Codex', 'BUILDER', 'BUZZ_ACP', 'INTERNAL_WRITE', '["coding","debugging","tests","recovery"]'::jsonb),
  ('claude', 'Claude', 'CRITIC', 'BUZZ_ACP', 'READ_ONLY', '["critique","review","red_team"]'::jsonb),
  ('verifier', 'Verifier', 'VERIFIER', 'DETERMINISTIC', 'READ_ONLY', '["receipts","source_of_truth","settlement"]'::jsonb)
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  role = EXCLUDED.role,
  adapter_kind = EXCLUDED.adapter_kind,
  authority_ceiling = EXCLUDED.authority_ceiling,
  capabilities_json = EXCLUDED.capabilities_json,
  updated_at = now();

CREATE TABLE IF NOT EXISTS brad_agent_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  objective_id UUID NOT NULL REFERENCES brad_objectives(id) ON DELETE CASCADE,
  source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN (
    'SHADOW', 'QUEUED', 'RUNNING', 'WAITING', 'WAITING_APPROVAL',
    'WAITING_VERIFICATION', 'BLOCKED', 'PAUSED', 'SUCCEEDED', 'FAILED', 'CANCELLED'
  )),
  reasoning_depth TEXT NOT NULL CHECK (reasoning_depth IN ('LIGHT', 'FULL')),
  phase TEXT NOT NULL,
  lead_agent_id TEXT NOT NULL REFERENCES brad_agent_registry(id),
  next_agent_id TEXT REFERENCES brad_agent_registry(id),
  current_assignment TEXT NOT NULL,
  authority_json JSONB NOT NULL,
  consecutive_agent_turns INTEGER NOT NULL DEFAULT 0,
  max_consecutive_agent_turns INTEGER NOT NULL DEFAULT 8 CHECK (max_consecutive_agent_turns BETWEEN 1 AND 32),
  cost_micros BIGINT NOT NULL DEFAULT 0,
  max_cost_micros BIGINT NOT NULL DEFAULT 5000000,
  deadline_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  evidence_summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  blocker_code TEXT,
  buzz_channel_id TEXT,
  buzz_root_event_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE(person_id, objective_id)
);

CREATE TABLE IF NOT EXISTS brad_agent_thread_participants (
  thread_id UUID NOT NULL REFERENCES brad_agent_threads(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES brad_agent_registry(id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_turn_at TIMESTAMPTZ,
  PRIMARY KEY(thread_id, agent_id)
);

CREATE TABLE IF NOT EXISTS brad_agent_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES brad_agent_threads(id) ON DELETE CASCADE,
  objective_id UUID NOT NULL REFERENCES brad_objectives(id) ON DELETE CASCADE,
  parent_message_id UUID REFERENCES brad_agent_messages(id) ON DELETE SET NULL,
  sender_agent_id TEXT NOT NULL REFERENCES brad_agent_registry(id),
  recipient_agent_ids TEXT[] NOT NULL DEFAULT '{}',
  message_type TEXT NOT NULL CHECK (message_type IN (
    'OWNER_REQUEST', 'FIRST_PRINCIPLES', 'DELEGATE', 'QUESTION', 'RESULT',
    'CRITIQUE', 'REVISION', 'VERIFY', 'BLOCKER', 'DECISION', 'SYSTEM'
  )),
  body TEXT NOT NULL,
  artifact_refs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_refs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  buzz_event_id TEXT,
  sequence_no BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(thread_id, idempotency_key),
  UNIQUE(thread_id, sequence_no)
);

CREATE TABLE IF NOT EXISTS brad_agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES brad_agent_threads(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES brad_agent_registry(id),
  provider_session_id TEXT,
  resume_ref TEXT,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'IDLE', 'BLOCKED', 'TERMINATED')),
  last_checkpoint_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(thread_id, agent_id)
);

CREATE TABLE IF NOT EXISTS brad_agent_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES brad_agent_threads(id) ON DELETE CASCADE,
  trigger_message_id UUID NOT NULL REFERENCES brad_agent_messages(id) ON DELETE CASCADE,
  assigned_agent_id TEXT NOT NULL REFERENCES brad_agent_registry(id),
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'LEASED', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'RECONCILE_REQUIRED', 'CANCELLED')),
  request_json JSONB NOT NULL,
  request_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_token UUID,
  leased_until TIMESTAMPTZ,
  worker_identity TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS brad_agent_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES brad_agent_threads(id) ON DELETE CASCADE,
  objective_id UUID NOT NULL REFERENCES brad_objectives(id) ON DELETE CASCADE,
  evaluator_agent_id TEXT NOT NULL REFERENCES brad_agent_registry(id),
  workflow_version TEXT NOT NULL,
  verified_outcome TEXT NOT NULL CHECK (verified_outcome IN ('VERIFIED', 'REJECTED', 'BLOCKED', 'UNVERIFIED')),
  score NUMERIC(5,2),
  evidence_quality NUMERIC(5,2),
  duration_ms BIGINT,
  cost_micros BIGINT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  intervention_count INTEGER NOT NULL DEFAULT 0,
  failure_cause TEXT,
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS brad_agent_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES brad_agent_threads(id) ON DELETE CASCADE,
  message_id UUID REFERENCES brad_agent_messages(id) ON DELETE CASCADE,
  destination TEXT NOT NULL CHECK (destination IN ('BUZZ', 'REDIS', 'TELEGRAM_BRIEF')),
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'RECONCILE_REQUIRED')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  external_event_id TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  UNIQUE(destination, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_threads_person_status
  ON brad_agent_threads(person_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_messages_thread_sequence
  ON brad_agent_messages(thread_id, sequence_no);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_claim
  ON brad_agent_jobs(status, next_attempt_at, created_at)
  WHERE status IN ('QUEUED', 'WAITING');
CREATE INDEX IF NOT EXISTS idx_agent_outbox_publish
  ON brad_agent_outbox(destination, status, next_attempt_at, created_at)
  WHERE status IN ('PENDING', 'FAILED');
CREATE INDEX IF NOT EXISTS idx_agent_sessions_person
  ON brad_agent_sessions(person_id, thread_id, agent_id);
