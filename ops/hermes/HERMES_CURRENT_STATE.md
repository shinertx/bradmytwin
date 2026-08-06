# Hermes Current State

Updated: 2026-08-04
Owner: Ben Jones
System: Brad agent runtime with Hermes as a bounded specialist worker

## Mission

Hermes investigates assigned work, produces source-backed findings, names the cheapest decisive next proof, and returns an artifact that Brad/Codex can verify. A report is not completion of the underlying issue.

Linear project `Brad Non-JENNI Operating Queue` is Ben's single human command board. Brad/Postgres is the durable machine control plane. OpenClaw is the current conversational runtime. Kimi Claw is a planned candidate replacement, not the current runtime, until the documented cutover checks pass. Hermes remains a specialist worker across either runtime.

## Current Runtime

- Hermes has a separate OpenAI OAuth credential named `openai-codex-oauth-1`.
- Default provider: `openai-codex`.
- Default model: `gpt-5.4-mini`.
- Managed policy: root-owned immutable `/etc/hermes/config.yaml` pins the provider/model and enables secret redaction.
- The bounded runner is `/home/benjijmac/bin/hermes-task-runner.sh`.
- The always-on Linear bridge is `brad-linear-hermes.service`.
- The evidence collector is `/home/benjijmac/bin/collect-hermes-evidence.sh`.
- Automated delegation uses the bounded runner, not Hermes' generic MCP channel-send surface.
- Automated Linear delegation is model-only/read-only and exposes only the `clarify` toolset. Hermes oneshot mode bypasses interactive tool approvals, so automated jobs receive no terminal, file, browser, code-execution, messaging, or computer-use tools.
- Automated skill preloading is disabled. The August 4 A/B benchmark found no quality-and-safety winner among `systematic-debugging`, `codebase-inspection`, and `plan`.
- Direct sessions run from `/home/benjijmac/.hermes/workspace-brad` and load its Brad-specific `AGENTS.md`.
- Ben's private browser dashboard runs on server loopback port `9120` through the existing Mac SSH tunnel.
- Brad API, web, worker, OpenClaw gateway, Hermes service, Linear bridge, and PostgreSQL were healthy after the August 4 command-loop deployment.
- A fresh no-delivery OpenClaw canary returned `OPENCLAW_MODEL_CANARY_OK` through agent `brad-runtime` on `openai/gpt-5.5`. Kimi remains uninstalled and was not cut over.

## Completed Hermes Delegations

These seven analysis runs completed successfully. The Linear issues remain open because their underlying outcomes are not yet proven.

| Issue | Hermes session | Verified conclusion | Next proof |
| --- | --- | --- | --- |
| BRA-33 | `20260804_074554_4b1bf7` | Core Brad/OpenClaw/Hermes services were healthy. Durable end-to-end ownership and channel delivery remain unproven. | Prove one task from intake through DB, worker, OpenClaw, verifier/receipt, and a fresh channel response. |
| BRA-10 | `20260804_074624_1ec5d9` | Active AI surfaces were identified. No candidate was proven safe for deletion. | Map ownership, observe replacement behavior for seven days, then quarantine only with rollback proof. |
| BRA-29 | `20260804_074654_38c491` | Darwin remains paper/replay only; simulator integrity and expectancy remain unproven. | Run the same frozen, fixed-seed replay twice with identical outputs, no lookahead, and explicit fees/slippage. |
| BRA-28 | `20260804_074720_2d6d7f` | No finalized settlement receipt or reconciled realized PnL was proven. | Reconcile an external settlement receipt to the internal ledger and realized net PnL. |
| BRA-24 | `20260804_074757_3481f4` | Persisted-state/schema drift is the leading decode hypothesis, but the failing payload/log was missing. | Compare direct decode with persistence round-trip decode on the same captured payload. |
| BRA-27 | `20260804_074843_d2ef38` | A Docker context/COPY mismatch is plausible; the exact failing instruction remains unproven. | Audit COPY/ADD against build context and capture one targeted safe build log. |
| BRA-26 | `20260804_074938_d51e93` | Compose configuration passed, but image availability, startup, health, and runtime behavior remain unproven. | Verify image references and rollback, then run the approved server-safe dry run. |

Result artifacts are under `/home/benjijmac/server-audits/hermes-delegation-20260804/results-v2/`. Linear is the task-status ledger; the repository and named evidence artifacts are the technical source of truth.

## Linear Command Loop Proof

- Linear contains 37 mirrored objectives: 35 imported work items, BRA-40 for the staged Kimi cutover, and BRA-41 for the command-loop canary.
- `In Progress` plus `Hermes` plus `Brad Run` authorizes one digest-keyed read-only Hermes analysis job. It does not authorize local mutation or an external effect.
- BRA-41's first timed-out attempt became `RECONCILE_REQUIRED`; it was not blindly retried.
- After process-group timeout handling and tool pinning were fixed, session `20260804_085230_a47622` produced a verified receipt and moved the synthetic canary to `Done` exactly once.
- Ordinary Hermes results remain `WAITING` until independently verified. Linear `Done`, a comment, or a label is not completion proof.

## Operating Rules

1. Read this file before Brad work and state which issue is being advanced.
2. Separate verified facts, inferences, assumptions, and unknowns.
3. Never promote healthy services or a completed analysis to completed business or technical outcomes.
4. Use bounded, read-only evidence collection first. Avoid broad filesystem scans and unbounded autonomous exploration.
5. Do not send messages, make payments, trade, file legal documents, change credentials or permissions, delete data, or mutate external accounts without an explicit action-specific approval.
6. Keep JENNI work outside this lane unless Ben explicitly transfers it.
7. Return: outcome, evidence, remaining gap, cheapest decisive next test, artifact path, and session ID.
8. Treat Kimi Claw as a candidate until authentication, session continuity, tools, approvals, recovery, channel delivery, and rollback are proven.
9. For automated Linear assignments, analyze only the issue evidence and this current-state packet. Do not attempt to obtain broader tools or authority.

## Immediate Priority

The synthetic Linear to Brad to Hermes to verified-receipt loop is proven. The highest-value open proof is now a real, non-synthetic objective that reaches independently verified completion without an external effect or approval bypass. Until that succeeds, describe Brad as a proven bounded command loop, not a proven autonomous business-outcome owner.
