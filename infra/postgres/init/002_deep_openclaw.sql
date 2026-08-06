ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS tool_name TEXT,
  ADD COLUMN IF NOT EXISTS tool_call_id TEXT,
  ADD COLUMN IF NOT EXISTS tool_input_json JSONB,
  ADD COLUMN IF NOT EXISTS openclaw_session_id TEXT,
  ADD COLUMN IF NOT EXISTS openclaw_response_id TEXT,
  ADD COLUMN IF NOT EXISTS origin_channel TEXT,
  ADD COLUMN IF NOT EXISTS origin_external_user_key TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS status_detail TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_requests_idempotency
  ON approval_requests(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE tool_invocations
  ADD COLUMN IF NOT EXISTS tool_call_id TEXT,
  ADD COLUMN IF NOT EXISTS approval_request_id UUID REFERENCES approval_requests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS latency_ms INTEGER,
  ADD COLUMN IF NOT EXISTS error_code TEXT;

ALTER TABLE runtime_sessions
  ADD COLUMN IF NOT EXISTS openclaw_session_id TEXT,
  ADD COLUMN IF NOT EXISTS last_response_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_sessions_openclaw_session_id
  ON runtime_sessions(openclaw_session_id)
  WHERE openclaw_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  due_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','CANCELLED','DONE')) DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  due_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('OPEN','DONE','CANCELLED')) DEFAULT 'OPEN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reminders_person_status ON reminders(person_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_person_status ON tasks(person_id, status, created_at DESC);
