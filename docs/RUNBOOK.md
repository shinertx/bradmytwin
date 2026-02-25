# Runbook

## Local bring-up
```bash
cp .env.example .env
npm install
npm run build
docker compose -f infra/docker/docker-compose.yml up --build
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

## Incident response
- If webhook failures spike: verify signature secrets and DNS/TLS status.
- If approvals stall: inspect worker logs and `approval_requests` statuses.
- If cross-user concern: query `messages`, `approvals`, and `audit_logs` by `person_id`.

## Beta safety toggles
- Disable unverified web access fast: set `BETA_ALLOW_UNVERIFIED_WEB=false` and restart API.
- Hard-stop all write actions: set `BETA_KILL_SWITCH_WRITES=true` and restart API.
- Keep write approval pressure high: set `BETA_STRICT_APPROVALS=true`.
