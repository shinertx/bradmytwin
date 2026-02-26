# API

## Inbound webhooks
- `POST /webhooks/twilio/sms`
- `POST /webhooks/twilio/whatsapp`
- `GET /webhooks/meta/whatsapp` (Meta webhook verification)
- `POST /webhooks/meta/whatsapp`
- `POST /webhooks/telegram`

## Web auth
- `GET /auth/me` (JWT required)
- `GET /auth/login/google/start`
- `GET /auth/login/google/callback?state=...&code=...`
- `POST /auth/login/google/exchange` body: `{ "code": "..." }`
- `POST /auth/otp/start` body: `{ "phone": "+15551234567" }`
- `POST /auth/otp/verify` body: `{ "phone": "+15551234567", "code": "123456" }`
- `POST /auth/phone/start` body: `{ "phone": "+15551234567" }`
- `POST /auth/phone/verify` body: `{ "phone": "+15551234567", "code": "123456" }` (JWT required)

## Connectors
- `POST /auth/link/google/start` body: `{ "scope": "calendar" | "email" }`
- `GET /auth/link/google/callback?state=...&code=...`
- `GET /connectors/status` (JWT required)
- `POST /auth/link/apple/start`

## Chat
- `POST /web/chat/messages` body: `{ "text": "..." }` (JWT required)
  - Response now includes:
    - `pendingApprovals: Array<{ id, actionType }>`
    - `runId`
    - `sessionId`
- `GET /web/chat/stream` SSE snapshot stream (JWT required)

## Approvals
- `POST /approvals/:token/confirm`
  - Response includes `executionState: "QUEUED" | "EXECUTED" | "FAILED"`
- `POST /approvals/:token/reject`
- `GET /approvals` (JWT required)
  - Response now includes `tool_name`, `tool_input_preview`, `origin_channel`, and `status_detail`

## Health
- `GET /healthz`
