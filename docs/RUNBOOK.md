# Runbook

## Local bring-up
```bash
cp .env.example .env
npm install
npm run build
docker compose -f infra/docker/docker-compose.yml up --build
```

## DB migration for existing environments
If your database was created before deep OpenClaw integration, apply:
```bash
psql "$DATABASE_URL" -f infra/postgres/init/002_deep_openclaw.sql
```

If your database was created before EA Control Tower integration, apply:
```bash
psql "$DATABASE_URL" -f infra/postgres/init/003_ea_control_tower.sql
```

If your database was created before the Brad Ownership Kernel integration, apply:
```bash
psql "$DATABASE_URL" -f infra/postgres/init/005_brad_ownership_kernel.sql
psql "$DATABASE_URL" -f infra/postgres/init/006_kernel_slice_1.sql
psql "$DATABASE_URL" -f infra/postgres/init/007_linear_hermes_control.sql
psql "$DATABASE_URL" -f infra/postgres/init/008_worker_tool_pins.sql
```

The kernel is not complete merely because the migration is applied. A `/do` objective must be visible in `brad_objectives`, have at least one checkpoint, and remain `WAITING` until independent outcome evidence is recorded.

## GCP VM deploy
1. Install Docker and Compose.
2. Clone repo and set `.env` secrets.
   Twilio in this repo requires `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM`, and optionally `TWILIO_WHATSAPP_FROM` for WhatsApp plus `TWILIO_VOICE_FROM` for deterministic IVR/keypad calls.
3. Point DNS for `brad.com` and `api.brad.com` to VM IP.
4. Request certificates via certbot on VM.
5. Start stack with compose.
6. Configure Twilio + Telegram webhook URLs.

## Current OpenClaw / Telegram deployment
Current production-like personal-agent deployment:
- GCP project: `arbitrage-bot-450800`
- VM: `meme-snipe-v19-vm`
- Zone: `us-central1-a`
- OpenClaw gateway: `openclaw-gateway.service` on `127.0.0.1:18789`
- Default agent: `brad-runtime`
- Model observed by the 2026-08-04 no-delivery canary: `openai/gpt-5.5`
- Telegram bot: `@Simpleclawtestingbbot`

See [`docs/OPENCLAW_TELEGRAM_HEARTBEAT.md`](./OPENCLAW_TELEGRAM_HEARTBEAT.md) for the complete setup, heartbeat, pairing, allowlist, and recovery runbook.

OpenClaw remains current until the Kimi Claw candidate passes [`docs/operations/KIMI_CLAW_CUTOVER_CHECKLIST.md`](./operations/KIMI_CLAW_CUTOVER_CHECKLIST.md). Do not stop or remove OpenClaw during candidate setup or shadow testing.

The current service uses `/home/benjijmac/.local/node-v24.18.0-linux-x64/bin/node`. The system shell's older Node binary does not satisfy OpenClaw's CLI version check, so operator canaries must prepend that Node 24 directory unless the shell runtime is upgraded deliberately.

## Hermes specialist worker

- Server workspace: `/home/benjijmac/.hermes/workspace-brad`
- Headless backend: `hermes-serve.service` on `127.0.0.1:9119`
- Private dashboard: `hermes-dashboard.service` on `127.0.0.1:9120`
- Mac access: double-click `~/Desktop/Open Hermes.command`
- Default inference: OpenAI Codex OAuth with `gpt-5.4-mini`
- Current-state source: `/home/benjijmac/server-audits/HERMES_CURRENT_STATE.md`
- Linear bridge: `brad-linear-hermes.service`

The dashboard stays loopback-only and reaches the Mac through SSH. See [`docs/operations/HERMES_OPERATING_MODEL.md`](./operations/HERMES_OPERATING_MODEL.md).

Automated Linear dispatch requires an issue in `In Progress` with both `Hermes` and `Brad Run`. It is model-only/read-only and does not inherit the broad tools available in a supervised dashboard session. The Linear API key lives in a mode-`0600` service environment file, not the repo.

## Common checks
- API: `curl http://localhost:3000/healthz`
- Web: `curl http://localhost:5173/healthz`
- DB: `docker exec -it <postgres-container> psql -U postgres -d brad`
- OpenClaw Responses: `curl -H "Authorization: Bearer $OPENCLAW_API_KEY" $OPENCLAW_URL/v1/responses`
- OpenClaw gateway heartbeat: `curl -fsS http://127.0.0.1:18789/readyz`
- Hermes backend: `curl -fsS http://127.0.0.1:9119/api/status`
- Hermes dashboard: `curl -fsS http://127.0.0.1:9120/api/status`
- Linear/Hermes bridge: `systemctl --user is-enabled brad-linear-hermes.service && systemctl --user is-active brad-linear-hermes.service`

## Incident response
- If webhook failures spike: verify signature secrets and DNS/TLS status.
- If approvals stall: inspect worker logs and `approval_requests.status/status_detail`.
- If a `/do` objective stalls: inspect `brad_objectives`, `brad_objective_checkpoints`, and `brad_objective_attempts`. The watchdog only moves stale work to `BLOCKED` with a reconciliation action; it never blindly replays an external effect.
- If cross-user concern: query `messages`, `approvals`, and `audit_logs` by `person_id`.
- If connector failures spike: inspect `/connectors/status` and token refresh errors.
- If EA automation looks stale: inspect `/ea/dashboard`, active rows in `ea_monitors`, and recent `ea_signal_ingested` audit events.
- If Telegram/OpenClaw is stale: run the heartbeat check in `docs/OPENCLAW_TELEGRAM_HEARTBEAT.md` before editing config.
- If a Hermes job times out after it started: inspect `brad_worker_jobs`, `brad_worker_job_attempts`, and `brad_worker_receipts`. A running lease becomes `RECONCILE_REQUIRED`; never reset it to queued until the Hermes session and artifact directory prove no effect or usable result exists.
- If a Linear receipt comment may have been duplicated: inspect `brad_projection_outbox` and the comment idempotency marker before replaying. The bridge reconciles an existing marker instead of posting a second comment.

## Beta safety toggles
- Disable unverified web access fast: set `BETA_ALLOW_UNVERIFIED_WEB=false` and restart API.
- Hard-stop all write actions: set `BETA_KILL_SWITCH_WRITES=true` and restart API.
- Keep write approval pressure high: set `BETA_STRICT_APPROVALS=true`.
