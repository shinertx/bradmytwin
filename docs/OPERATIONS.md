# Operations

## Runtime Services
- `api` Fastify app.
- `worker` approval executor.
- `web` static + login/chat UI.
- `postgres`, `redis`, `nginx`.

## Required Secrets
- Twilio credentials.
- Telegram bot token and webhook secret.
- JWT secret.
- Google OAuth client credentials.
- GCP KMS key name + service account permissions.

## Observability
- Application logs from containers.
- Audit trail in `audit_logs` table.
- Health checks at `/healthz`.
