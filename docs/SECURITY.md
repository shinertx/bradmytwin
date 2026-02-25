# Security

## Request Authenticity
- Twilio webhook signatures validated when token is configured.
- Telegram webhook secret validated on every inbound request.

## Token Protection
- OAuth token payloads encrypted using AES-GCM with per-token DEK.
- DEK wrapping via GCP KMS (`KMS_KEY_NAME`) when configured.
- Approval tokens are never stored plaintext; SHA-256 hash only.

## Isolation Controls
- Every query is scoped by `person_id`.
- Redis lock and runtime keys are scoped by `person_id`.
- Merge operations require explicit confirmation.

## Write Gating
Write actions require approval:
- `SEND_EMAIL`
- `CREATE_EVENT`
- `UPDATE_EVENT`
- `SUBMIT_FORM`
