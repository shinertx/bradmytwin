# Architecture

## Components
- Channel Gateways: SMS/WhatsApp (Twilio), Telegram (Bot API), Web.
- Identity Service: canonical `person_id`, channel identities, auth identities.
- Twin Router: resolves identity, onboarding/runtime decision, routes to OpenClaw.
- OpenClaw Adapter: primary path is Gateway HTTP Responses API (`POST /v1/responses`) with deterministic tool-call loop, function-call outputs, and session-key reuse.
- Approval Service: write-action pause, tokenized approval, idempotent resume.
- Tool Registry: curated 28-skill allowlist, schema validation, write/read policy metadata.
- Connector Service: real Google OAuth code exchange, encrypted token storage, and refresh flow.
- Auth Service: Google login OAuth (separate from connector OAuth), phone OTP fallback, identity merge and JWT issuance.
- Worker: claims approved actions, executes real writes, resumes OpenClaw via `function_call_output`, emits completion notifications.

## Data Isolation
- All data keyed by `person_id`.
- Runtime lock and runtime session keyed by `lock:person:{person_id}` and `runtime:person:{person_id}`.
- No shared in-memory user state.

## Runtime Lifecycle
1. Inbound webhook/web chat message arrives.
2. Identity resolved or created.
3. Onboarding flow or ACTIVE runtime execution selected.
4. OpenClaw executes with user-specific connectors/model and curated tool definitions.
5. Router validates tool calls and executes read tools inline (max 2 retries).
6. Write actions become approval requests with persisted resume context.
7. Worker executes approved write and continues the same OpenClaw session.

## Beta Mode Flags
- `BETA_ALLOW_UNVERIFIED_WEB`: allow web onboarding/runtime without phone verification.
- `BETA_STRICT_APPROVALS`: force approval on all write intents.
- `BETA_KILL_SWITCH_WRITES`: block all write execution paths at runtime.
