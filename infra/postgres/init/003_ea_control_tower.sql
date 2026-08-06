CREATE TABLE IF NOT EXISTS ea_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('EMAIL','SMS','WHATSAPP','TELEGRAM','CALENDAR','DRIVE','DOCS','SHEETS','TASKS','PORTAL','BROWSER','CHAT','MANUAL','SYSTEM')),
  source_ref TEXT,
  sender TEXT,
  subject TEXT,
  body_preview TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  priority TEXT NOT NULL CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')) DEFAULT 'NORMAL',
  classification TEXT NOT NULL CHECK (classification IN ('ACTION','WAITING','SCHEDULE','FILE','REFERENCE','IGNORE','APPROVAL')) DEFAULT 'REFERENCE',
  status TEXT NOT NULL CHECK (status IN ('NEW','TRIAGED','CONVERTED','IGNORED')) DEFAULT 'NEW',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS source_signal_id UUID REFERENCES ea_signals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')) DEFAULT 'NORMAL',
  ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT 'brad',
  ADD COLUMN IF NOT EXISTS waiting_on TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS ea_source_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  record_type TEXT NOT NULL CHECK (record_type IN ('PERSON','ENTITY','ACCOUNT','CASE','VENDOR','PROPERTY','PREFERENCE','DEADLINE','OTHER')),
  title TEXT NOT NULL,
  summary TEXT,
  source_url TEXT,
  source_signal_id UUID REFERENCES ea_signals(id) ON DELETE SET NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('UNVERIFIED','USER_ATTESTED','SOURCE_BACKED')) DEFAULT 'UNVERIFIED',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ea_monitors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  monitor_type TEXT NOT NULL CHECK (monitor_type IN ('EMAIL','SMS','CALENDAR','DRIVE','TASKS','PORTAL','WEBHOOK','SYSTEM')),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','PAUSED','ERROR')) DEFAULT 'ACTIVE',
  cadence_minutes INTEGER NOT NULL DEFAULT 60,
  last_checked_at TIMESTAMPTZ,
  last_error TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(person_id, monitor_type, name)
);

CREATE INDEX IF NOT EXISTS idx_ea_signals_person_status ON ea_signals(person_id, status, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ea_signals_person_priority ON ea_signals(person_id, priority, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_person_due ON tasks(person_id, status, due_at NULLS LAST, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ea_source_records_person_type ON ea_source_records(person_id, record_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ea_monitors_person_status ON ea_monitors(person_id, status, monitor_type);
