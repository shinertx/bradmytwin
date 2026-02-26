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
