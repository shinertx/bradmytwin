# Architecture

## Components
- Channel Gateways: SMS/WhatsApp (Twilio), Telegram (Bot API), Web.
- Identity Service: canonical `person_id`, channel identities, auth identities.
- Twin Router: resolves identity, onboarding/runtime decision, routes to OpenClaw.
- OpenClaw Adapter: primary path is Gateway HTTP Responses API (`POST /v1/responses`) with deterministic tool-call loop, function-call outputs, and session-key reuse.
- Agent Runtime Boundary: Brad owns durable state, identity, approvals, retries, receipts, and verification. OpenClaw is the current runtime adapter; Kimi Claw is a planned candidate adapter and cannot become current until parity and rollback checks pass.
- Linear Command Board: `Brad Non-JENNI Operating Queue` is the single human work surface. Linear source state is mirrored into Brad, but a comment, priority, or `Done` state is neither approval nor completion proof.
- Hermes Specialist Worker: receives bounded tasks and evidence packets, performs research/coding/debugging, and returns artifacts for independent verification. Hermes does not own objective state or execute approval-gated external effects.
- Linear/Hermes Dispatcher: `brad-linear-hermes.service` polls the command board, creates digest-keyed jobs, leases attempts, invokes Hermes with pinned model/tool metadata, records receipts, and projects idempotent comments. Automated runs expose only the model-level `clarify` toolset.
- Approval Service: write-action pause, tokenized approval, idempotent resume.
- Brad Ownership Kernel: `/do` creates a durable objective before model execution, records checkpoints and attempts, binds approvals to a canonical payload digest, and keeps completion in `WAITING` until independent evidence exists.
- Tool Registry: curated 28-skill allowlist, schema validation, write/read policy metadata.
- Connector Service: real Google OAuth code exchange, encrypted token storage, and refresh flow.
- Auth Service: Google login OAuth (separate from connector OAuth), phone OTP fallback, identity merge and JWT issuance.
- Worker: claims approved actions, executes real writes, resumes OpenClaw via `function_call_output`, emits completion notifications.
- EA Control Tower: ingests email/SMS/calendar/portal/manual signals, classifies them, turns actionable items into tracked tasks, stores source records, and exposes one operating dashboard.
- Phone Tools: conversational outbound calls use `phone.call_agent` through Call-E; deterministic keypad/IVR calls use `phone.call_ivr` through Twilio Voice DTMF. The router only creates an approval request for either write tool; the worker starts the live call after approval and returns provider state for follow-up checks.
- OpenClaw Heartbeat Layer: systemd keeps the gateway running, `/readyz` exposes liveness, Telegram long polling provides the remote command surface, and Brad health checks prove the local app path stays available.
- Buzz Coordination Layer: the private Buzz control room is the shared event, decision, and proof surface for Brad/OpenClaw, Codex, Claude, and the owner. It does not replace Brad's identity isolation, approval service, worker, or audit tables. See [`BUZZ_COORDINATION.md`](./BUZZ_COORDINATION.md).

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
8. Brad records the provider result as a receipt, or marks the attempt `UNKNOWN` and requires source-of-truth reconciliation before retry.

## Linear To Hermes Lifecycle

1. Linear issues are mirrored into `brad_linear_issues` and linked to one durable `brad_objectives` row per person and Linear issue.
2. Only `In Progress` plus `Hermes` plus `Brad Run` creates a Hermes job.
3. The request digest is the idempotency identity; unchanged polls cannot create duplicate jobs.
4. A worker leases the job and records a start attempt before invoking Hermes.
5. Automated Hermes runs are read-only analysis with no terminal, file, browser, code-execution, messaging, or computer-use tools.
6. Success records the session, provider, model, skills, toolsets, usage, artifact path, and artifact hash.
7. Ordinary success leaves the objective `WAITING` for independent verification. A Linear `Done` claim without a verified receipt also remains `WAITING`.
8. Projection uses a transactional outbox and Linear comment markers so restart or retry cannot duplicate comments or state transitions.
9. An expired pre-start lease may be requeued. An expired running attempt becomes `RECONCILE_REQUIRED` and is never blindly rerun.

## Phone Agent Flow
1. User asks Brad to call someone and provides an E.164 phone number plus the call goal.
2. OpenClaw requests `phone.call_agent`.
3. Router validates the phone number/goal and creates a `PLACE_PHONE_CALL` approval.
4. User confirms the approval token.
5. Worker invokes Call-E through the local `calle` CLI and stores the returned run payload in the approval result.
6. Later turns can use `phone.get_call_status` with the returned `run_id`.

## IVR / Keypad Call Flow
1. User asks Brad to complete a known phone-menu path and provides an E.164 phone number, goal, and DTMF digit sequence.
2. OpenClaw requests `phone.call_ivr`.
3. Router validates the phone number, goal, and DTMF sequence, then creates a `PLACE_PHONE_CALL` approval.
4. User confirms the approval token.
5. Worker invokes Twilio Voice with TwiML that speaks a short intro, waits, and plays the approved DTMF digits.
6. Later turns can use `phone.get_ivr_call_status` with the returned Twilio call SID.

## Autonomous EA Layer
The EA layer is autonomous for read/triage/organization work and conservative for writes:
1. Signals arrive from email, SMS, chat, calendar, portal, browser, Drive, or manual entry.
2. The Control Tower classifies each signal as action, waiting, schedule, approval, reference, file, or ignore.
3. Actionable signals become tasks with category, priority, owner, waiting-on, and source-link metadata.
4. Source records preserve durable operating truth separately from volatile messages.
5. Any external write still routes through the existing approval gate.

## OpenClaw Telegram Heartbeat Flow
1. Systemd starts `openclaw-gateway.service` on the GCP VM.
2. Gateway binds to `127.0.0.1:18789` and returns `/readyz`.
3. Telegram plugin starts long polling for the configured bot.
4. Allowlisted Telegram user sends a DM command.
5. OpenClaw logs inbound Telegram identity, runs the selected model, and sends a Telegram reply.
6. Heartbeat checks confirm service readiness, Brad API/web health, Telegram provider startup, and latest inbound/reply proof.

The detailed operational source is [`OPENCLAW_TELEGRAM_HEARTBEAT.md`](./OPENCLAW_TELEGRAM_HEARTBEAT.md).

Hermes usage and the Kimi Claw transition gates are documented in [`operations/HERMES_OPERATING_MODEL.md`](./operations/HERMES_OPERATING_MODEL.md) and [`operations/KIMI_CLAW_CUTOVER_CHECKLIST.md`](./operations/KIMI_CLAW_CUTOVER_CHECKLIST.md).

## Beta Mode Flags
- `BETA_ALLOW_UNVERIFIED_WEB`: allow web onboarding/runtime without phone verification.
- `BETA_STRICT_APPROVALS`: force approval on all write intents.
- `BETA_KILL_SWITCH_WRITES`: block all write execution paths at runtime.
