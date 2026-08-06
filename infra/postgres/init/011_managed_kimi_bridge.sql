-- Durable correlation for the managed Kimi Claw inbound bridge.

CREATE TABLE IF NOT EXISTS brad_managed_kimi_inbound (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('KIMI', 'TELEGRAM')),
  external_message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  sender_id TEXT,
  content_digest TEXT NOT NULL,
  source_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  objective_id UUID NOT NULL REFERENCES brad_objectives(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES brad_agent_threads(id) ON DELETE CASCADE,
  executive_job_id UUID NOT NULL REFERENCES brad_agent_jobs(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(channel, external_message_id)
);

CREATE INDEX IF NOT EXISTS idx_managed_kimi_inbound_thread
  ON brad_managed_kimi_inbound(thread_id, created_at DESC);
