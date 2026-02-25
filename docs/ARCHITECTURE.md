# Architecture

## Components
- Channel Gateways: SMS/WhatsApp (Twilio), Telegram (Bot API), Web.
- Identity Service: canonical `person_id`, channel identities, auth identities.
- Twin Router: resolves identity, onboarding/runtime decision, routes to OpenClaw.
- OpenClaw Adapter: supports Gateway CLI mode (`openclaw agent --json`) and HTTP adapter mode (`/v1/...`), with runtime bootstrap/reuse, retries, and policy injection.
  - In CLI mode, use a dedicated OpenClaw agent profile (`OPENCLAW_CLI_AGENT_ID`) with restrictive tool policy to avoid bypassing Brad approval gates.
- Approval Service: write-action pause, tokenized approval, idempotent resume.
- Connector Service: OAuth links and encrypted token storage.
- Worker: executes approved pending actions and emits completion notifications.

## Data Isolation
- All data keyed by `person_id`.
- Runtime lock and runtime session keyed by `lock:person:{person_id}` and `runtime:person:{person_id}`.
- No shared in-memory user state.

## Runtime Lifecycle
1. Inbound webhook/web chat message arrives.
2. Identity resolved or created.
3. Onboarding flow or ACTIVE runtime execution selected.
4. OpenClaw executes with user-specific skills/permissions/connectors.
5. Runtime is provisioned/reused per user with model profile settings.
6. Write actions become approval requests.
7. Worker executes approved requests and marks as executed.
