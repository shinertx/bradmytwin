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
psql "$DATABASE_URL" -f infra/postgres/init/005_brad_ownership_kernel.sql
psql "$DATABASE_URL" -f infra/postgres/init/006_kernel_slice_1.sql
psql "$DATABASE_URL" -f infra/postgres/init/009_agent_conductor.sql
```

## GCP VM deploy
1. Install Docker and Compose.
2. Clone repo and set `.env` secrets.
3. Point DNS for `brad.com` and `api.brad.com` to VM IP.
4. Request certificates via certbot on VM.
5. Start stack with compose.
6. Configure Twilio + Telegram webhook URLs.

## Common checks
- API: `curl http://localhost:3000/healthz`
- Web: `curl http://localhost:5173/healthz`
- DB: `docker exec -it <postgres-container> psql -U postgres -d brad`
- OpenClaw Responses: `curl -H "Authorization: Bearer $OPENCLAW_API_KEY" $OPENCLAW_URL/v1/responses`

## Incident response
- If webhook failures spike: verify signature secrets and DNS/TLS status.
- If approvals stall: inspect worker logs and `approval_requests.status/status_detail`.
- If cross-user concern: query `messages`, `approvals`, and `audit_logs` by `person_id`.
- If connector failures spike: inspect `/connectors/status` and token refresh errors.

## Beta safety toggles
- Disable unverified web access fast: set `BETA_ALLOW_UNVERIFIED_WEB=false` and restart API.
- Hard-stop all write actions: set `BETA_KILL_SWITCH_WRITES=true` and restart API.
- Keep write approval pressure high: set `BETA_STRICT_APPROVALS=true`.

## Multi-agent rollout

1. Set `BRAD_CONDUCTOR_MODE=shadow` on API and worker.
2. Apply migrations `005`, `006`, and `009`; build and restart.
3. Verify ordinary Telegram and web responses still occur exactly once.
4. Confirm Redis Stream `brad:agent:jobs` receives one wakeup for a new outbox record and that a duplicate wakeup cannot re-run a settled job.
5. Start `@brad/buzz-bridge` on the Mac through the existing API tunnel. Keep its token outside Git and its Buzz private key in the existing protected key file.
6. Link Kimi to this existing OpenClaw runtime through `kimi.com/bot`; back up the OpenClaw config first and retain the current model profile as rollback.
7. Run the runtime, conversation, restart, loop, safety, reconciliation, and two-person isolation canaries.
8. Set `BRAD_CONDUCTOR_MODE=active` only after the documented promotion threshold passes.

Immediate rollback: set `BRAD_CONDUCTOR_MODE=shadow` and restart API/worker. Do not delete agent tables; they are the recovery and audit record.
