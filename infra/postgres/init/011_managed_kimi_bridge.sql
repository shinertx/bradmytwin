-- Durable correlation for the managed Kimi Claw inbound bridge.

CREATE TABLE IF NOT EXISTS brad_managed_kimi_inbound (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('KIMI', 'TELEGRAM', 'WEB')),
  external_message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  sender_id TEXT,
  content_digest TEXT NOT NULL,
  source_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  objective_id UUID NOT NULL REFERENCES brad_objectives(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES brad_agent_threads(id) ON DELETE CASCADE,
  executive_job_id UUID NOT NULL REFERENCES brad_agent_jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PENDING',
  claim_token UUID,
  claim_owner TEXT,
  claim_expires_at TIMESTAMPTZ,
  response_digest TEXT,
  settled_at TIMESTAMPTZ,
  delivery_status TEXT NOT NULL DEFAULT 'PENDING',
  delivery_message_id TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT brad_managed_kimi_inbound_identity_key
    UNIQUE(person_id, channel, conversation_id, external_message_id)
);

-- Migration 011 was exercised by an earlier candidate. Make reruns converge that
-- candidate schema instead of relying on CREATE TABLE IF NOT EXISTS to alter it.
ALTER TABLE brad_managed_kimi_inbound
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS claim_owner TEXT,
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS response_digest TEXT,
  ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_status TEXT,
  ADD COLUMN IF NOT EXISTS delivery_message_id TEXT,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

UPDATE brad_managed_kimi_inbound SET status = 'PENDING' WHERE status IS NULL;
UPDATE brad_managed_kimi_inbound SET delivery_status = 'PENDING' WHERE delivery_status IS NULL;

UPDATE brad_managed_kimi_inbound
SET status = 'RECONCILE_REQUIRED', claim_token = NULL, claim_owner = NULL,
    claim_expires_at = NULL, response_digest = NULL, settled_at = NULL
WHERE status NOT IN ('PENDING', 'CLAIMED', 'SETTLED', 'RECONCILE_REQUIRED');

UPDATE brad_managed_kimi_inbound
SET status = 'PENDING', claim_token = NULL, claim_owner = NULL,
    claim_expires_at = NULL, response_digest = NULL, settled_at = NULL
WHERE status = 'CLAIMED'
  AND (
    claim_token IS NULL OR claim_owner IS NULL OR claim_expires_at IS NULL
    OR response_digest IS NOT NULL OR settled_at IS NOT NULL
  );

UPDATE brad_managed_kimi_inbound
SET status = 'RECONCILE_REQUIRED', claim_token = NULL, claim_owner = NULL,
    claim_expires_at = NULL, response_digest = NULL, settled_at = NULL
WHERE status = 'SETTLED'
  AND (
    response_digest IS NULL OR settled_at IS NULL
    OR claim_token IS NOT NULL OR claim_owner IS NOT NULL OR claim_expires_at IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM brad_agent_jobs j
      WHERE j.id = brad_managed_kimi_inbound.executive_job_id
        AND j.person_id = brad_managed_kimi_inbound.person_id
        AND j.status = 'SUCCEEDED'
    )
  );

UPDATE brad_managed_kimi_inbound
SET claim_token = NULL, claim_owner = NULL, claim_expires_at = NULL,
    response_digest = NULL, settled_at = NULL
WHERE status IN ('PENDING', 'RECONCILE_REQUIRED');

UPDATE brad_managed_kimi_inbound
SET delivery_status = 'RECONCILE_REQUIRED', delivery_message_id = NULL, delivered_at = NULL
WHERE delivery_status NOT IN ('PENDING', 'DELIVERED', 'RECONCILE_REQUIRED');

UPDATE brad_managed_kimi_inbound
SET delivery_status = 'PENDING', delivery_message_id = NULL, delivered_at = NULL
WHERE status <> 'SETTLED';

UPDATE brad_managed_kimi_inbound
SET delivery_status = 'RECONCILE_REQUIRED', delivery_message_id = NULL, delivered_at = NULL
WHERE delivery_status = 'DELIVERED' AND delivered_at IS NULL;

UPDATE brad_managed_kimi_inbound
SET delivery_message_id = NULL, delivered_at = NULL
WHERE delivery_status IN ('PENDING', 'RECONCILE_REQUIRED');

ALTER TABLE brad_managed_kimi_inbound
  ALTER COLUMN status SET DEFAULT 'PENDING',
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN delivery_status SET DEFAULT 'PENDING',
  ALTER COLUMN delivery_status SET NOT NULL,
  DROP CONSTRAINT IF EXISTS brad_managed_kimi_inbound_channel_external_message_id_key,
  DROP CONSTRAINT IF EXISTS brad_managed_kimi_inbound_channel_check,
  DROP CONSTRAINT IF EXISTS brad_managed_kimi_inbound_status_check,
  DROP CONSTRAINT IF EXISTS brad_managed_kimi_inbound_claim_state_check,
  DROP CONSTRAINT IF EXISTS brad_managed_kimi_inbound_delivery_status_check,
  DROP CONSTRAINT IF EXISTS brad_managed_kimi_inbound_delivery_state_check;

ALTER TABLE brad_managed_kimi_inbound
  ADD CONSTRAINT brad_managed_kimi_inbound_channel_check
    CHECK (channel IN ('KIMI', 'TELEGRAM', 'WEB')),
  ADD CONSTRAINT brad_managed_kimi_inbound_status_check
    CHECK (status IN ('PENDING', 'CLAIMED', 'SETTLED', 'RECONCILE_REQUIRED')),
  ADD CONSTRAINT brad_managed_kimi_inbound_delivery_status_check
    CHECK (delivery_status IN ('PENDING', 'DELIVERED', 'RECONCILE_REQUIRED')),
  ADD CONSTRAINT brad_managed_kimi_inbound_claim_state_check CHECK (
    (status = 'PENDING'
      AND claim_token IS NULL AND claim_owner IS NULL AND claim_expires_at IS NULL
      AND response_digest IS NULL AND settled_at IS NULL)
    OR (status = 'CLAIMED'
      AND claim_token IS NOT NULL AND claim_owner IS NOT NULL AND claim_expires_at IS NOT NULL
      AND response_digest IS NULL AND settled_at IS NULL)
    OR (status = 'SETTLED'
      AND claim_token IS NULL AND claim_owner IS NULL AND claim_expires_at IS NULL
      AND response_digest IS NOT NULL AND settled_at IS NOT NULL)
    OR (status = 'RECONCILE_REQUIRED'
      AND claim_token IS NULL AND claim_owner IS NULL AND claim_expires_at IS NULL
      AND response_digest IS NULL AND settled_at IS NULL)
  ),
  ADD CONSTRAINT brad_managed_kimi_inbound_delivery_state_check CHECK (
    (status <> 'SETTLED'
      AND delivery_status = 'PENDING'
      AND delivery_message_id IS NULL AND delivered_at IS NULL)
    OR (status = 'SETTLED' AND delivery_status = 'PENDING'
      AND delivery_message_id IS NULL AND delivered_at IS NULL)
    OR (status = 'SETTLED' AND delivery_status = 'DELIVERED'
      AND delivered_at IS NOT NULL)
    OR (status = 'SETTLED' AND delivery_status = 'RECONCILE_REQUIRED'
      AND delivery_message_id IS NULL AND delivered_at IS NULL)
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'brad_managed_kimi_inbound'::regclass
      AND conname = 'brad_managed_kimi_inbound_identity_key'
  ) THEN
    ALTER TABLE brad_managed_kimi_inbound
      ADD CONSTRAINT brad_managed_kimi_inbound_identity_key
      UNIQUE(person_id, channel, conversation_id, external_message_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_managed_kimi_inbound_thread
  ON brad_managed_kimi_inbound(thread_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_managed_kimi_inbound_recovery
  ON brad_managed_kimi_inbound(person_id, status, claim_expires_at, updated_at)
  WHERE status IN ('PENDING', 'CLAIMED');
