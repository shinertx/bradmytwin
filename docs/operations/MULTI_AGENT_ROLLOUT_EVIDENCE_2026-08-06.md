# Brad Multi-Agent Rollout Evidence - 2026-08-06

## Decision

Keep the conductor in `shadow`. The durable system and projections are working, but production promotion is blocked by renewable Kimi server authentication, a stable Kimi outbound bridge, and the 20 low-risk live-objective gate.

## Production State

- GCP Brad API, web, worker, OpenClaw, Telegram, Linear/Hermes services: active.
- OpenClaw production: `2026.7.1-2`, Node `24.18.0`, model `openai/gpt-5.5`.
- Conductor: `shadow` in API and worker; no shadow objective dispatches a worker job.
- Kimi: official plugin `0.27.1` linked to the existing Brad instance; separate managed Kimi instance preserved.
- Buzz Desktop: upgraded from `0.5.3` to verified `0.5.5`; original app preserved in dated quarantine.
- Buzz bridge: dedicated signing identity, protected Brad API token, signed receipts, and explicit Codex/Claude mentions.

## Durable Control Plane

Implemented records and services cover:

- agent registry, threads, participants, messages, sessions, jobs, evaluations, and transactional outbox;
- normal-message intake with optional `/do`;
- proportional first-principles reasoning;
- deterministic next-agent selection and an eight-turn hard limit;
- Hermes session metadata and authority envelope;
- verifier-only completion with evidence;
- Redis Streams wakeups plus a two-minute stale-work recovery scan;
- lease recovery, pause/cancel late-result defense, receipt reconciliation, redaction, JENNI exclusion, and person isolation.

## Canary Evidence

### Buzz and shadow rollout

- Buzz `0.5.5` signed canary returned `BRAD_BUZZ_055_CANARY_OK`.
- Ten synthetic shadow objectives were created: eight `LIGHT`, two `FULL`.
- Result: ten `SHADOW` threads, twenty agent messages, twenty Buzz receipts, twenty published Buzz outbox rows, zero worker jobs.
- A normal web intake created a durable objective and first-principles message, then projected both into Buzz under the dedicated bridge identity.

### Kimi channel and K3 model

- Stable OpenClaw receives Kimi input but the plugin records `final=0` and sends zero blocks. Stable is not promoted.
- Isolated OpenClaw `2026.7.2-beta.7` delivered `KIMI_BETA_DELIVERY_OK` visibly through Kimi using a deterministic model canary.
- Kimi Code K3 answered `KIMI_K3_LOCAL_CANARY_OK` locally.
- K3 answered `OPENCLAW_KIMI_K3_CANARY_OK` through isolated OpenClaw.
- Full channel result: Kimi UI -> isolated OpenClaw beta -> K3 -> Kimi UI returned `KIMI_FULL_PATH_K3_CANARY_20260806_0707Z` visibly once.
- The full-path canary used a short-lived OAuth token via an environment SecretRef. It does not establish unattended production authentication.

### Rollback and compatibility

- Both beta gateway switches used automatic three-minute stable-runtime watchdogs.
- Stable OpenClaw and Telegram were restored after each canary.
- An earlier beta inspection had advanced the shared stable SQLite schema from version 1 to 6. The database was backed up, a downgrade candidate was opened successfully by the stable library, the live version metadata was restored to 1, integrity check passed, and stable OpenClaw restarted cleanly.
- Future beta commands must set `OPENCLAW_STATE_DIR` explicitly; profile isolation alone is not accepted as sufficient evidence.

## Automated Verification

- Domain: 9 tests passed.
- API: 7 tests passed, including four database-backed conductor tests.
- Worker: 9 tests passed.
- Buzz bridge: 4 tests passed.
- Full TypeScript build passed.
- Package audit reported zero vulnerabilities.
- Focused tests passed for person isolation, resumable blocked work, exact signed reply binding, verifier evidence, loop cutoff, JENNI denial, artifact hashing, expired-lease recovery, pause race defense, Redis outbox idempotency, and ambiguous Telegram reconciliation.

## Promotion Gate

Still required before `active`:

1. Renewable Kimi server credential or a tested OAuth refresh service that never stores a token in Git.
2. Stable OpenClaw release with the beta Kimi outbound behavior, or an explicitly approved beta observation window.
3. Approval pause/resume and in-progress restart recovery on the K3 path.
4. Twenty low-risk live objectives with zero lost objectives, unauthorized or duplicate effects, and false critical completions.
5. At least 90% verified completion or precise blockers and at least 20% fewer Ben interventions than baseline.

Until all five pass, Telegram/stable OpenClaw remains the production channel and the conductor remains shadow-only.
