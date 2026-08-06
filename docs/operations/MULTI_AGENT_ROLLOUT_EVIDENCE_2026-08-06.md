# Brad Multi-Agent Rollout Evidence - 2026-08-06

## Decision

Keep the multi-agent system in a guarded candidate state. The managed Kimi lane may create live jobs for explicit canaries, while ordinary Telegram and API intake remains `shadow`. Do not call the system fully promoted until the remaining low-risk live-objective gate and intervention comparison pass.

## Current Runtime State

- GCP services `brad-api`, `brad-web`, `brad-worker`, `brad-linear-hermes`, and `openclaw-gateway` are active.
- The GCP Brad runtime remains the single production Telegram consumer on OpenClaw `2026.7.1-2`, Node `24.18.0`, and rollback model `openai/gpt-5.5`.
- API intake is `shadow`. The worker is `active` only so explicitly created managed-Kimi candidate jobs can execute.
- The separate Kimi-managed instance is preserved. Its authenticated `brad-managed-kimi` bridge is version `1.5.4`; it is not the production Telegram consumer.
- The proven managed model remains `kimi-coding/k2p6`. The aligned 2026.7.1-2 administrative CLI reports it as both `defaultModel` and `resolvedDefault`.
- The official Kimi target for K3 is `kimi-coding/k3` with a `1.0m` context. A live switch resolved to K3, but the first response failed with `Your account is suspended`; K3 is therefore `BLOCKED_BY_KIMI_PLAN`, not promoted. No purchase was made. The exact pre-change config was restored and K2P6 passed a fresh conversation canary.
- The managed shell originally resolved `openclaw` to 2026.4.14 while the gateway used `/opt/openclaw-2026.7.1-2`. `/root/.local/bin/openclaw` now wraps the exact gateway package, removing administrative schema drift without changing the service command.
- Buzz Desktop is `0.5.5`. `com.brad.buzz-bridge` and the separately signed `com.brad.buzz-codex-agent` are both running locally.

## Implemented Control Plane

The candidate now provides:

- durable objectives, authority envelopes, threads, participants, messages, jobs, sessions, evaluations, and transactional outbox records;
- normal-message intake with optional `/do` and proportional first-principles reasoning;
- deterministic one-agent-at-a-time routing with an eight-turn hard stop;
- managed Kimi executive decisions, bounded Hermes execution, signed Codex critique, Hermes revision, and verifier-only closure;
- exact-marker proof contracts that cannot be satisfied by copying the owner's request;
- Redis Streams wakeups, two-minute stale-work scans, resumable sessions, and restart-safe checkpoints;
- startup recovery that immediately requeues interrupted non-external work but quarantines possible external effects;
- exact-job Buzz reply binding, one specialist notification per delegation, person isolation, JENNI denial, secret redaction, artifact hashing, and receipt reconciliation.

## Live Canary Evidence

### Runtime and channel

- Runtime marker `MANAGED_RUNTIME_CANARY_20260806_Z9C6` produced one inbound claim and one exact Brad response.
- The official Kimi connector did not emit a generic final-delivery receipt. Brad therefore recorded `RECONCILE_REQUIRED` for delivery instead of claiming provider-confirmed delivery or retrying.

### Conversation V3

- Thread: `ed46b24c-2e0b-4d9f-8551-146113b058ba`.
- Flow: owner -> first principles -> Brad/Kimi -> Hermes -> Codex -> Hermes revision -> verifier.
- Proof: `MULTI_AGENT_CONVERSATION_V3_OK` and evaluation `VERIFIED`.
- One manual recovery dispatch was required while fixing the old duplicate-notification behavior. Preserve this run as baseline evidence, not as a fully automatic pass.

### Automatic conversation V4

- Thread: `7ca95058-2db7-4a4d-a0f5-67f5399dbb0c`.
- The complete Brad/Kimi -> Hermes -> signed Codex -> Hermes revision -> verifier flow ran without manual recovery.
- Proof: `MULTI_AGENT_AUTOMATIC_V4_OK`, thread `SUCCEEDED/VERIFIED`, and exactly one matching Codex mention-feed event.

### Restart recovery V5

- Thread: `62a34b01-7059-4b01-a012-52eb738e917f`.
- The first restart test found a real defect: the Redis consumer and untracked timers prevented prompt worker shutdown, and a running turn could remain leased beyond the five-minute recovery target.
- Commit `7eaa4b0` added clean timer/Redis shutdown and startup reconciliation.
- After deployment, a forced interruption caused startup recovery to report `{ requeued: 1, blocked: 0 }`. The same Hermes job completed on attempt two and the verifier closed the objective 16 seconds after restart.
- Proof: `RECOVERY_AFTER_RESTART_V5_OK`, thread `SUCCEEDED/VERIFIED`.
- A subsequent ordinary `systemctl restart brad-worker` completed in about three seconds and returned active.

### Model rollback and bridge V6S

- The K3 configuration test was backed up first and failed at the account-plan gate before Brad intake.
- The original hook policy and `kimi-coding/k2p6` model were restored. The gateway returned active.
- Thread `9940fcf5-e1be-4da5-b9fa-805c0abe3d1c` then completed the automatic Brad/Kimi -> Hermes -> signed Codex -> Hermes revision -> verifier flow.
- Proof: `RESTORED_BRIDGE_V6S_OK`, thread `SUCCEEDED/VERIFIED`.

## Shadow And Live Counts

- Shadow gate: 10/10 threads created with 20 durable messages and no worker jobs.
- Low-risk live gate: 4/20 independently verified objectives completed.
- Verified live completion so far: 100% of the four completed candidate objectives, but the sample is below the required 20 and is not promotion evidence by itself.

## Automated Verification

- Domain: 10 tests passed.
- API: 7 tests passed.
- Worker: 23 tests passed.
- Buzz bridge: 5 tests passed.
- Managed Kimi bridge: 32 tests passed.
- Full TypeScript build passed.

The tests explicitly cover 100-way intake deduplication, exact reply identity, stale-run rejection, loop cutoff, JENNI denial before and after an adapter call, foreign-person isolation, secret redaction, artifact digest verification, verifier evidence, restart recovery, external-effect quarantine, pause races, Redis idempotency, and Telegram/provider receipt reconciliation.

## Remaining Promotion Gates

1. Resolve the Kimi account-plan suspension before retrying K3. Do not authorize a purchase implicitly. After access is restored, prove `kimi-coding/k3`, context `1.0m`, with a fresh response and durable objective.
2. Complete 16 more low-risk live objectives, for 20 total, with zero lost objectives, unauthorized or duplicate effects, and false critical completions.
3. Compare owner intervention rate against the recorded baseline and prove at least a 20% reduction.
4. Keep missing provider delivery receipts as `RECONCILE_REQUIRED`; do not promote exact-response evidence to delivered-channel proof.

## Rollback

Set API and worker `BRAD_CONDUCTOR_MODE=shadow`, restart those services, and keep the existing Telegram/OpenClaw path. The database, Buzz transcript, evidence, and audit trail remain intact. Do not delete the separate managed Kimi instance until all promotion gates pass.
