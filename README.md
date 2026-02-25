# Brad.com Omnichannel Digital Twin MVP

Brad.com is a channel-agnostic Digital Twin platform that supports SMS, WhatsApp, Telegram, and Web chat with phone-anchored identity, approval-gated write actions, and per-user isolation.

## What is included

- `apps/api`: Fastify API for webhooks, routing, auth, connectors, approvals, and web chat.
- `apps/worker`: approval execution worker and async processing.
- `apps/web`: web app server with OTP login, chat, approvals, and connector actions.
- `packages/domain`: shared types, onboarding state machine, permission helpers.
- `packages/clients`: shared OpenClaw, Twilio, Telegram, and KMS envelope clients.
- `infra/postgres/init/001_schema.sql`: full schema for multi-tenant isolation.
- `infra/docker/docker-compose.yml`: local and GCP VM runtime stack.
- `infra/nginx/nginx.conf`: TLS + reverse proxy for `brad.com` and `api.brad.com`.

## Quickstart

1. Copy env template:

```bash
cp .env.example .env
```

2. Install dependencies:

```bash
npm install
```

3. Build all packages:

```bash
npm run build
```

4. Start local stack with Docker Compose:

```bash
docker compose -f infra/docker/docker-compose.yml up --build
```

5. Health checks:

- API: `http://localhost:3000/healthz`
- Web: `http://localhost:5173/healthz`

## Core API Endpoints

- `POST /webhooks/twilio/sms`
- `POST /webhooks/twilio/whatsapp`
- `POST /webhooks/telegram`
- `POST /auth/otp/start`
- `POST /auth/otp/verify`
- `POST /auth/link/google/start`
- `GET /auth/link/google/callback`
- `POST /auth/link/apple/start`
- `POST /identity/merge/start`
- `POST /identity/merge/confirm`
- `POST /web/chat/messages`
- `GET /web/chat/stream`
- `POST /approvals/:token/confirm`
- `POST /approvals/:token/reject`
- `GET /approvals`

## Notes

- Twilio and Telegram are safe to run in dev without credentials: outbound messages log to console.
- Google OAuth callback is scaffolded and stores encrypted token blobs with KMS envelope logic.
- OpenClaw integration uses an HTTP adapter; fallback stub is active when `OPENCLAW_URL` is not set.
- OpenClaw can run in three modes via `OPENCLAW_MODE`:
  - `stub`: local deterministic fallback (default for dev)
  - `http`: calls external `/v1/...` OpenClaw HTTP adapter
  - `cli`: calls local `openclaw agent --json` via CLI (best for Gateway-based deployments)
- For `cli` mode, set `OPENCLAW_CLI_AGENT_ID` to a locked-down OpenClaw agent profile (recommended: deny `group:openclaw` tools and let Brad app handle approvals).

See [`docs`](./docs) for architecture, security, API, and runbook details.
