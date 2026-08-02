# Buzz Coordination Contract

## Purpose

Buzz is the shared coordination, decision, and audit surface for Brad/OpenClaw,
Codex, Claude, and the owner. It is not a second executor, memory database, or
approval service.

The Brad application remains the system of record for identity isolation,
connector state, tool policy, approval requests, execution, and audit outcomes.
Buzz records the shared operating conversation and proof links around that work.

## Roles

- **Benji / owner:** sets priorities, approves consequential writes, and resolves conflicts.
- **Brad / OpenClaw:** primary personal-agent executor and channel operator. It reads the owner's requests, proposes actions, and executes only through the Brad approval worker.
- **Codex:** implementation, diagnostics, repository changes, and verification.
- **Claude:** independent review, reasoning, and adversarial checking. It does not become a second executor.
- **Buzz Desktop:** human-facing control-room client using the same private relay and room.

## One Process

Every material request follows this sequence:

1. **Perceive:** collect the request and relevant source evidence.
2. **Decide:** state the objective, binding constraint, assumptions, and proposed next action.
3. **Propose:** write the smallest reversible action and its success threshold into the control room.
4. **Approve:** require owner approval for external sends, purchases, payments, account changes, deletion, deployment, legal filings, credential operations, or other consequential writes.
5. **Execute:** perform the approved action through the owning system. Buzz must never be used to bypass Brad/OpenClaw approval gates.
6. **Verify:** check the real external or production result, not just a local command or queued job.
7. **Remember:** store durable facts, blockers, and proof links in the owning project source of truth; keep Buzz as the coordination record.

## Proof Language

Use exact state labels:

- `drafted`
- `proposed`
- `approved`
- `executed`
- `verified`
- `deployed`
- `customer-live`
- `paid`
- `settled`
- `blocked`

Never promote one state to another without evidence. A plan is not execution;
an API response is not customer-live; a payment submission is not settled.

## Room Rules

- Keep one private **Brad Control Room** for cross-agent coordination and owner decisions.
- Create separate project rooms only when a project needs independent access, history, or retention.
- Tag the responsible worker in a request. Do not broadcast every message to every agent.
- Agents respond to owner messages only unless an explicit allowlist is configured.
- Do not copy credentials, tokens, full private records, or sensitive personal data into Buzz.
- Avoid acknowledgement loops. A reply must contain a decision, evidence, blocker, or next action.

## Safety Boundaries

The following remain controlled by Brad/OpenClaw and its worker:

- outbound messages and calls
- purchases, payments, and account changes
- legal or government submissions
- deletion or destructive cleanup
- deployments and production configuration
- credentials and secret rotation

Buzz approval or membership is not authorization for any of these actions.

## Health Proof

The local setup is considered coordinated only when all applicable checks pass:

- Buzz relay readiness is `ready`.
- Owner, Codex, Claude, and Desktop identities authenticate to the intended relay.
- Codex produces a fresh signed response in the private room.
- Claude produces a fresh signed response through an authenticated ACP path, or is explicitly marked `blocked` when only a Claude.ai subscription is available and the ACP adapter requires an Anthropic API credential.
- OpenClaw gateway readiness, provider authentication, and a real `openclaw agent` response are separately verified on the server runtime.
- Brad API, worker, and audit paths remain healthy.
- External writes still create and resolve Brad approval records.

Do not call the full system "working" when only the relay or desktop UI is up.

## Current Local Deployment

- Relay: `ws://127.0.0.1:3100`
- Relay health: `http://127.0.0.1:8181/_readiness`
- Control room: `Brad Control Room`
- Desktop app: `/Applications/Buzz.app`
- Local container data: isolated Colima profile `buzz`
- Buzz Desktop onboarding: completed for the local Brad Control Room; the
  desktop identity is visible as `Ben Jones` and can see the shared channels.
- Buzz Desktop default: Codex harness with the current Codex default model;
  Claude Code is also detected and available for separate agent assignments.
- Codex ACP: authenticated and canary-verified
- Claude ACP: provider is available through the local Claude CLI, but the official ACP adapter does not accept Claude.ai subscription authentication without an Anthropic API credential
- OpenClaw/Brad bridge: verified through the identified `meme-snipe-v19-vm` runtime; gateway is active and enabled, the configured `brad-runtime` agent returned a fresh model response, and Telegram is connected. The Mac CLI remains a client surface, not a second gateway.

## Buzz Release Alignment

- Buzz Desktop is pinned to the latest official release verified on 2026-08-01:
  `0.5.3`.
- The local Buzz source checkout is clean and synchronized with `origin/main`;
  do not replace the signed Desktop app with an untagged development build.
- Keep reply/liveness protection enabled where the selected harness supports it.
  The external Codex ACP bridge is separately verified with a signed canary, so
  a missing room reply is treated as a failed proof rather than ignored.
- Keep ACP heartbeats disabled by default. Existing scheduled automations are
  the explicit heartbeat layer; an ACP self-prompt loop would add duplicate
  work and could create action noise.
- Create and verify a local encrypted Buzz identity backup before treating the
  Desktop identity as recoverable. The backup passphrase must be chosen and
  retained by the owner; it must never be generated into logs or committed
  files. Current proof: the identity is persisted in the macOS keychain, but
  the owner-selected encrypted backup has not yet been created.
- Local REST token bypass is acceptable only for the loopback development relay.
  Any cloud or shared relay must set `BUZZ_REQUIRE_AUTH_TOKEN=true`, supply a
  separate relay private key, and verify every client after the coordinated
  cutover.

## Verified Server Proof (2026-08-02)

- OpenClaw server gateway: `systemd --user` active and enabled on loopback port
  `18789`; gateway connectivity probe passed.
- Provider/model: `brad-runtime` completed a fresh read-only canary through the
  Codex harness using `openai/gpt-5.5`.
- Telegram: default account is configured, running, connected, and polling as
  `@Simpleclawtestingbbot`.
- Brad API tunnel: `GET /healthz` returned `{"ok":true,"service":"api"}`.
- The Mac's installed OpenClaw CLI is older than the server runtime and uses a
  different Node version; use the server runtime or the authenticated tunnel
  UI for operations until the local CLI is deliberately aligned.
- The service reports a non-blocking patch-level metadata warning after the
  server update; runtime, gateway, model, and Telegram probes remain healthy.

## Cloud Cutover Rule

Before moving the relay or OpenClaw execution to GCP, identify the exact GCP
project, region, host, persistent volumes, DNS/Tailscale endpoint, and secret
store. Export and restore a proof-bearing configuration, then verify relay,
agent auth, OpenClaw readiness, Brad health, and a fresh end-to-end message.
Do not treat a successful deployment command as proof of a working cutover.
