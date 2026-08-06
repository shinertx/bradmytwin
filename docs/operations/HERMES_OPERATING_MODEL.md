# Hermes Operating Model

## Decision

Hermes is Brad's specialist worker for bounded research, code inspection, debugging, evidence collection, and proof-oriented analysis. It is not the durable task ledger, the approval authority, or the primary messaging runtime.

This separation is intentional:

- Brad owns objectives, identity isolation, approvals, attempts, receipts, and completion state.
- Linear project `Brad Non-JENNI Operating Queue` is Ben's single non-JENNI command board.
- Kimi Claw is the planned conversational/channel runtime after a verified cutover.
- OpenClaw remains the current runtime until that cutover passes.
- Hermes performs delegated specialist work and returns evidence to Brad/Codex for independent verification.

## How Ben Uses Hermes

Double-click `Open Hermes.command` on the Mac Desktop. It opens the private Hermes dashboard over the existing SSH tunnel. Hermes remains bound to server loopback and is not exposed publicly.

Use direct Hermes chat for:

- researching or explaining a bounded question;
- inspecting a repository or server state;
- debugging a specific failure;
- producing a draft, evidence packet, or implementation candidate;
- advancing a named Linear issue with an explicit proof target.

Use Brad or Codex instead when the request spans multiple projects, needs account/browser routing, changes operating policy, or requires independent completion verification.

## Delegation Contract

Every Hermes assignment should contain:

1. The Linear issue or durable objective identifier.
2. The requested outcome.
3. The evidence Hermes may inspect.
4. The authority boundary.
5. The exact completion proof.
6. The output artifact location.

Hermes must return:

- verified facts;
- inferences and unknowns;
- work actually performed;
- evidence and artifact paths;
- the remaining gap;
- the cheapest decisive next test;
- its session ID.

A successful Hermes session proves the analysis completed. It does not prove the underlying business or technical outcome completed.

## Integration Decision

Use the private dashboard for direct human chat and `hermes-task-runner.sh` for automated delegation. Do not register Hermes' generic MCP server as a Brad/Codex worker interface yet: the currently exposed MCP surface includes channel-send operations and does not provide the narrow, approval-safe task contract Brad requires. Reconsider MCP only after a dedicated bounded delegation tool exposes objective ID, evidence boundary, authority boundary, artifact destination, and receipt.

The active automated path is:

1. Ben places a Linear issue in `In Progress` and applies both `Hermes` and `Brad Run`.
2. `brad-linear-hermes.service` mirrors the issue into Brad/Postgres and creates one digest-keyed job.
3. Hermes receives the issue plus the managed current-state packet with only the `clarify` toolset. Automated Hermes jobs are read-only analysis; oneshot mode bypasses interactive tool approvals, so terminal, file, browser, code execution, messaging, and computer-use tools are not exposed.
4. Brad records the attempt, usage, provider, model, toolsets, skills, artifact hash, and session ID.
5. Brad posts the receipt back to Linear. An ordinary result stays `WAITING` until an independent verifier proves the outcome.

`Brad Run` authorizes this bounded analysis only. It never authorizes a send, payment, trade, deployment, credential change, deletion, legal filing, or other external effect.

## Model And Context

- Default provider: OpenAI Codex OAuth.
- Default model: `gpt-5.4-mini`.
- Deployment policy pins the provider, model, and secret redaction in `/etc/hermes/config.yaml`. The root-owned file is immutable because a runtime configuration path was observed rewriting the managed default; planned changes must temporarily remove and then restore the immutable flag.
- Current-state source: `/home/benjijmac/server-audits/HERMES_CURRENT_STATE.md`.
- Direct workspace: `/home/benjijmac/.hermes/workspace-brad`.
- Automated runner: `/home/benjijmac/bin/hermes-task-runner.sh`.

The automated runner prepends the current-state source to every bounded task. Direct dashboard and terminal sessions load the workspace `AGENTS.md`, which requires the same current-state source to be read before Brad work.

## Skill Policy

Automated skill preloading is disabled. A 2026-08-04 A/B benchmark tested `systematic-debugging`, `codebase-inspection`, and `plan`; none improved the evidence-and-safety rubric. See [`HERMES_SKILL_BENCHMARK_2026-08-04.md`](./HERMES_SKILL_BENCHMARK_2026-08-04.md).

Skills may still be used in a supervised dashboard session. They do not expand authority, enable tools, or supply completion proof.

## Authority Boundary

Hermes may inspect, reason, draft, test safely, and create local artifacts. It may not independently:

- send messages or publish;
- spend money, pay, buy, sell, or trade;
- sign or file legal documents;
- change account credentials, permissions, or external settings;
- delete data;
- declare an external outcome complete without a receipt or source-of-truth check.

These actions stay behind Brad's approval and reconciliation path.

## Runtime Transition

Kimi Claw is a candidate replacement for the online OpenClaw conversational runtime. It does not replace Brad's ownership kernel, Linear, or Hermes.

Do not disable OpenClaw until Kimi Claw proves all of the following:

1. Authenticated model response.
2. Stable session continuity.
3. Tool-call and tool-result continuation compatibility.
4. Per-person identity isolation.
5. Approval pause and resume through Brad.
6. No duplicate external effects after retries or crashes.
7. Fresh channel round trip.
8. Health monitoring and rollback to OpenClaw.

Until those checks pass, describe Kimi Claw as `planned candidate`, OpenClaw as `current runtime`, and Hermes as `active specialist worker`.

## Health Proof

Hermes is usable only when all of these are true:

- `brad-linear-hermes.service` is enabled and active;
- `hermes-dashboard.service` is active;
- the private dashboard responds through the Mac tunnel;
- OpenAI Codex OAuth is logged in;
- the default model/provider are correct;
- a fresh bounded prompt returns a nonempty result and usage receipt;
- the result reflects the current-state file and authority boundary.

The verified command-loop canary is Linear issue `BRA-41`. Its first timed-out attempt was preserved as `RECONCILE_REQUIRED` and was not blindly retried. After process-group timeout handling and tool pinning were corrected, session `20260804_085230_a47622` returned a verified receipt and moved the canary to `Done` exactly once.
