-- 006_kernel_slice_1.sql
-- Kernel slice 1: durable task contract versioning + approval execution attempt ledger.
-- Source plan: docs/KERNEL_SLICE_1_BUILD_PLAN_2026-08-03.md
-- Additive only; no changes to existing rows' behavior.

-- Every approval carries the version of the contract it was created under.
ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS contract_version int NOT NULL DEFAULT 1;

-- Execution ledger for ALL approvals (objective-flow and plain-chat alike).
-- One row per execution attempt; the worker must write 'started' before any
-- provider call and 'provider_submitted' immediately before dispatch.
CREATE TABLE IF NOT EXISTS brad_approval_attempts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id          uuid NOT NULL REFERENCES approval_requests(id),
  attempt_no           int NOT NULL,
  request_digest       text NOT NULL,        -- copied from approval_requests.payload_digest at claim time
  verified_digest      text,                 -- worker-recomputed digest at execution time
  digest_match         boolean,              -- execution forbidden unless true
  status               text NOT NULL,        -- started | provider_submitted | succeeded | failed | unknown
  provider_name        text,
  provider_effect_id   text,                 -- Google event id, Gmail message id, CallE/Twilio sid, ...
  started_at           timestamptz NOT NULL DEFAULT now(),
  provider_submitted_at timestamptz,
  finished_at          timestamptz,
  error                text,
  UNIQUE (approval_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS brad_approval_attempts_approval_status
  ON brad_approval_attempts (approval_id, status);

-- The reconciler's working set: attempts dispatched to a provider but never finalized.
CREATE INDEX IF NOT EXISTS brad_approval_attempts_unfinalized
  ON brad_approval_attempts (status)
  WHERE status = 'provider_submitted';
