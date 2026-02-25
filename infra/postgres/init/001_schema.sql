CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS persons (
  id UUID PRIMARY KEY,
  preferred_name TEXT,
  phone_e164 TEXT UNIQUE,
  phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
  onboarding_state TEXT NOT NULL CHECK (onboarding_state IN ('ASK_NAME','ASK_CONNECT_CALENDAR','ASK_CONNECT_EMAIL','CONFIRM_READY','ACTIVE')),
  timezone TEXT,
  email_signature_style TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channel_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('SMS','WHATSAPP','TELEGRAM','WEB')),
  external_user_key TEXT NOT NULL,
  phone_e164_nullable TEXT,
  verified_phone BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(channel, external_user_key)
);

CREATE TABLE IF NOT EXISTS auth_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('GOOGLE','APPLE','PHONE_OTP')),
  provider_user_id TEXT NOT NULL,
  email_nullable TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS threads (
  id UUID PRIMARY KEY,
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  primary_channel TEXT NOT NULL CHECK (primary_channel IN ('SMS','WHATSAPP','TELEGRAM','WEB')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY,
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('SMS','WHATSAPP','TELEGRAM','WEB')),
  thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  body TEXT NOT NULL,
  provider_msg_id TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  resource TEXT NOT NULL,
  can_read BOOLEAN NOT NULL DEFAULT TRUE,
  requires_approval_for_write BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS skills_enabled (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  skill TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(person_id, skill)
);

CREATE TABLE IF NOT EXISTS connectors (
  id UUID PRIMARY KEY,
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  scope TEXT NOT NULL,
  token_ciphertext JSONB NOT NULL,
  refresh_ciphertext JSONB,
  expires_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('PENDING','CONNECTED','ERROR','REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(person_id, provider, scope)
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID PRIMARY KEY,
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('SEND_EMAIL','CREATE_EVENT','UPDATE_EVENT','SUBMIT_FORM')),
  payload_json JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','EXECUTED','FAILED')),
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tool_invocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  tool_name TEXT NOT NULL,
  input_json JSONB NOT NULL,
  output_json JSONB,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY,
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runtime_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','IDLE','TERMINATED')),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_profiles (
  person_id UUID PRIMARY KEY REFERENCES persons(id) ON DELETE CASCADE,
  model_name TEXT NOT NULL,
  temperature NUMERIC(4,2) NOT NULL DEFAULT 0.2,
  max_tokens INTEGER NOT NULL DEFAULT 1500,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_person_created ON messages(person_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approvals_person_status ON approval_requests(person_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_person_created ON audit_logs(person_id, created_at DESC);
