# API

## Inbound webhooks
- `POST /webhooks/twilio/sms`
- `POST /webhooks/twilio/whatsapp`
- `GET /webhooks/meta/whatsapp` (Meta webhook verification)
- `POST /webhooks/meta/whatsapp`
- `POST /webhooks/telegram`

## Web auth
- `POST /auth/otp/start` body: `{ "phone": "+15551234567" }`
- `POST /auth/otp/verify` body: `{ "phone": "+15551234567", "code": "123456" }`

## Connectors
- `POST /auth/link/google/start` body: `{ "scope": "calendar" | "email" }`
- `GET /auth/link/google/callback?state=...&code=...`
- `POST /auth/link/apple/start`

## Chat
- `POST /web/chat/messages` body: `{ "text": "..." }` (JWT required)
- `GET /web/chat/stream` SSE snapshot stream (JWT required)

## Approvals
- `POST /approvals/:token/confirm`
- `POST /approvals/:token/reject`
- `GET /approvals` (JWT required)

## Health
- `GET /healthz`
