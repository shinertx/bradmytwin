# Security

## Request Authenticity
- Twilio webhook signatures validated when token is configured.
- Meta WhatsApp webhooks validate verify-token challenge and `X-Hub-Signature-256`.
- Telegram webhook secret validated on every inbound request.
- Google login callback validates one-time OAuth state from Redis.

## Token Protection
- OAuth token payloads encrypted using AES-GCM with per-token DEK.
- DEK wrapping via GCP KMS (`KMS_KEY_NAME`) when configured.
- Approval tokens are never stored plaintext; SHA-256 hash only.

## Isolation Controls
- Every query is scoped by `person_id`.
- Redis lock and runtime keys are scoped by `person_id`.
- Merge operations require explicit confirmation.
- Web login exchange tokens are single-use with 60-second TTL (`auth:google:exchange:*`).

## Write Gating
Write actions require approval:
- `SEND_EMAIL`
- `CREATE_EVENT`
- `UPDATE_EVENT`
- `SUBMIT_FORM`

## Beta Guardrails
- `BETA_ALLOW_UNVERIFIED_WEB` controls temporary web-only access without phone verification.
- `BETA_STRICT_APPROVALS` enforces approval on all write intents in beta.
- `BETA_KILL_SWITCH_WRITES` hard-blocks all write execution with a safe assistant response.
- Rate limits are enforced on Google auth routes, phone auth routes, and `/web/chat/messages`.
