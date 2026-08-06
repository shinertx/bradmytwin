CREATE TABLE IF NOT EXISTS brad_kimi_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  objective_id UUID NOT NULL REFERENCES brad_objectives(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'PAUSED', 'COMPLETED', 'REVOKED')),
  authority TEXT NOT NULL DEFAULT 'READ_ONLY_ANALYSIS'
    CHECK (authority = 'READ_ONLY_ANALYSIS'),
  max_dispatches_per_hour INTEGER NOT NULL DEFAULT 4
    CHECK (max_dispatches_per_hour BETWEEN 1 AND 12),
  last_pulled_at TIMESTAMPTZ,
  last_decision_digest TEXT,
  last_decision_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (person_id, objective_id)
);

CREATE INDEX IF NOT EXISTS idx_brad_kimi_assignments_active
  ON brad_kimi_assignments (status, updated_at)
  WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS brad_kimi_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL REFERENCES brad_kimi_assignments(id) ON DELETE CASCADE,
  objective_id UUID NOT NULL REFERENCES brad_objectives(id) ON DELETE CASCADE,
  objective_version INTEGER NOT NULL,
  action TEXT NOT NULL
    CHECK (action IN ('DISPATCH_HERMES', 'WAIT', 'REQUEST_APPROVAL')),
  request_digest TEXT NOT NULL UNIQUE,
  rationale TEXT NOT NULL,
  hermes_prompt TEXT,
  worker_job_id UUID REFERENCES brad_worker_jobs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (action = 'DISPATCH_HERMES' AND hermes_prompt IS NOT NULL)
    OR (action <> 'DISPATCH_HERMES' AND hermes_prompt IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_brad_kimi_decisions_assignment
  ON brad_kimi_decisions (assignment_id, created_at DESC);
