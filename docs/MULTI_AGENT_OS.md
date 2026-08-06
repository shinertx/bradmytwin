# Brad Multi-Agent Operating System

## Identity And Authority

Brad is the Kimi-powered executive identity. The durable Brad API/Postgres control plane owns objectives, authority, checkpoints, approvals, receipts, and final status. OpenClaw, Hermes, Codex, Claude, Buzz, Telegram, and Kimi are adapters or channels; none may override control-plane state.

JENNI is excluded by the default authority envelope. External sends, spending, publishing, deletion, deployment, legal actions, and credential changes remain approval-gated.

## Runtime Flow

1. Every active-user message creates a durable objective and agent thread.
2. Every objective receives a proportional first-principles brief.
3. In `shadow`, the existing OpenClaw response path continues while the conductor records its contract.
4. In `active`, Brad/Kimi delegates to Hermes; full-depth work receives Codex or Claude critique; Hermes revises; the independent verifier evaluates evidence.
5. Only the verifier may close an objective, and only with nonempty evidence satisfying the stored verification contract.
6. Buzz receives the full signed conversation through the transactional outbox. Telegram receives only the normal Brad response and, after promotion, concise decisions, blockers, approvals, and final outcomes.

## Safety Invariants

- A worker turn may succeed while its objective remains waiting.
- Agent replies cannot increase the stored authority envelope.
- Eight consecutive agent turns stop with `LOOP_BUDGET_EXHAUSTED`.
- An expired pre-run lease may be requeued. An expired running turn becomes `RECONCILE_REQUIRED`.
- On a known singleton-worker restart, interrupted work with `externalEffectsAllowed=false` is reclaimed immediately. Work that may have produced an external effect is quarantined for reconciliation instead of replayed.
- Ambiguous external writes remain `reconcile_required`; they are never blindly replayed.
- Owner messages reset the agent-turn counter.
- Buzz replies are accepted only through the authenticated bridge and only for the exact waiting job and assigned agent.
- JENNI references are rejected before an agent adapter runs unless a future explicit transfer changes the stored authority envelope.
- Secret-like values are redacted from Buzz and Telegram projections while the person-isolated control plane retains the authoritative message.
- Artifact verification recomputes the stored SHA-256 digest; file existence alone is not proof.
- Linear and Buzz are projections, not completion authorities.

## Data Plane

- `brad_objectives`: requested outcome and proof contract.
- `brad_agent_threads`: state machine, budgets, authority, routing, and blocker.
- `brad_agent_messages`: immutable participant turns and proof references.
- `brad_agent_sessions`: provider session continuity and checkpoints.
- `brad_agent_jobs`: leased, idempotent agent work.
- `brad_agent_outbox`: transactional projection attempts for Buzz, Redis Streams, and Telegram briefs. Delivery is at-least-once; deterministic markers, receipts, and idempotent consumers make processing effectively once without claiming an impossible cross-system transaction.
- `brad_agent_evaluations`: verified outcome, quality, cost, duration, retry, and intervention measurements.

## Promotion Gate

Keep normal Telegram and API intake in `shadow` until all tests pass. The worker may remain active for explicitly created managed-Kimi candidate jobs:

- zero lost objectives;
- zero unauthorized or duplicate effects;
- zero false critical completions;
- at least 90% verified completion or precise blocker;
- interrupted work reconciles or resumes within five minutes;
- at least 20% fewer unnecessary owner interventions than baseline.

Rollback is one configuration change: restore `BRAD_CONDUCTOR_MODE=shadow` and restart the API and worker. This preserves all objectives, messages, evidence, and audit state.

## Kimi, Telegram, And Buzz Cutover

- The managed Kimi Claw named `Brad` is the primary executive candidate. The GCP OpenClaw gateway remains an inactive conversational rollback runtime while the GCP Brad API/Postgres/worker services remain authoritative and active.
- Telegram must have one polling consumer. Follow [`docs/operations/MANAGED_KIMI_TELEGRAM_CUTOVER.md`](./operations/MANAGED_KIMI_TELEGRAM_CUTOVER.md) for the current ownership record and fail-closed rollback.
- Back up `openclaw.json` before the plugin install and retain the current model as rollback.
- Confirm the linked runtime reports the intended Kimi model before changing the worker model profile.
- Buzz Desktop `0.5.5` is the promotion target. Preserve the existing identity and prove relay readiness plus a signed message before and after the upgrade.

## Managed Kimi Bridge Contract

The non-bundled `brad-managed-kimi` plugin must be loaded only on a supported managed OpenClaw runtime with this policy shape:

```json
{
  "enabled": true,
  "hooks": {
    "allowConversationAccess": true,
    "allowPromptInjection": true
  },
  "config": {
    "managedAgentId": "main",
    "managedMainAccountDigest": "<sha256-account-fingerprint>",
    "managedOwnerIdentity": "kimi-claw:main",
    "managedTelegramBindingDigest": "<sha256-telegram-v1-account-owner-private-chat>",
    "managedTelegramOwnerDigest": "<sha256-paired-telegram-owner-id>",
    "modelProvider": "kimi-coding",
    "model": "k2p6",
    "recoveryEnabled": true
  }
}
```

Use `recoveryEnabled: false` in isolated staging. The production bridge uses `true` only after exact account fingerprinting, cross-context claim persistence, stale-run rejection, and recovery tests pass. Telegram run fallback must require the exact authoritative provider, user trigger, command-owner verdict, three matching canonical sender fields, a private chat equal to that sender, the selected bot account, the exact managed-main session, and non-conflicting run IDs. The binding fingerprint is SHA-256 over `telegram:v1:<account>:<owner>:<private-chat>`.

The bridge uses the provider message ID for durable deduplication whenever an inbound hook emits it. The synthesized managed-Telegram fallback has no provider update ID and therefore uses the stable OpenClaw run ID; replay of one Telegram update under a different run ID remains a live cutover proof gate. The bridge requires an explicit trusted-owner signal, settles the executive response in Postgres before final delivery, blocks all unclaimed tools, renews live claims, and reschedules expired work into the original OpenClaw session. The recovery claim token stays in plugin memory and is rotated to the exact resumed run before model execution.

Kimi's current official K3 identity is `kimi-coding/k3` with a `1.0m` context. The current proven candidate remains `kimi-coding/k2p6`; a live K3 canary reached the Kimi account-plan suspension gate and was rolled back. Do not retry K3 or authorize a purchase without owner approval, and do not label the candidate K3 until a fresh response and durable objective prove the upgraded model.
