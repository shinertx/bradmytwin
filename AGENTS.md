# AGENTS.md

## Project Intent
Build and operate Brad.com omnichannel Digital Twin MVP (SMS, WhatsApp, Telegram, Web) with phone-anchored identity, per-user isolation, and approval-gated write actions.

## User Collaboration Mode
- The project owner is non-technical.
- The agent must own execution of engineering workflow end-to-end:
  - branching strategy
  - commits and pull/push flow
  - environment setup
  - deployment steps
  - verification and rollback planning
- Do not ask the user to perform Git/branch/tree operations unless there is no other option.
- Maintain explicit running context in status updates so project state is always clear.

## Repository Structure
- `apps/api`: Fastify API for webhooks, auth, connectors, approvals, and web chat.
- `apps/worker`: background approval execution worker.
- `apps/web`: web app server and static UI.
- `packages/domain`: shared types and onboarding/permission logic.
- `packages/clients`: OpenClaw/Twilio/Telegram/KMS integration clients.
- `infra/postgres/init`: SQL schema.
- `infra/docker`, `infra/nginx`: deployment assets.

## Core Rules
- Preserve strict `person_id` data isolation.
- Do not bypass approval gates for write actions.
- Keep read access allowed by default unless product requirements change.
- Keep OpenClaw execution bound to per-user runtime and model profile.
- OpenClaw setup is incomplete until:
  - gateway is healthy, and
  - model-provider auth is configured (real API key/token), and
  - a real `openclaw agent` test returns a model-generated response.

## Local Verification Commands
- Build: `npm run build`
- Tests: `npm test`
- Health checks (when running):
  - API: `GET /healthz`
  - Web: `GET /healthz`

## Acceptance Focus
- Two users must never leak data across identities.
- Scheduling/email write actions must require approval first.
- Audit logs must show inbound, execution, approvals, and outcomes.

## Documentation Source of Truth
- `docs/PRD.md`
- `docs/ARCHITECTURE.md`
- `docs/API.md`
- `docs/SECURITY.md`
- `docs/TEST_PLAN.md`
- `docs/RUNBOOK.md`
