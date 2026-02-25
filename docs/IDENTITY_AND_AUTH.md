# Identity and Auth

## Canonical Identity
`person_id` is the tenant boundary.

## Identity Graph
- `channel_identities`: maps channel user keys to `person_id`.
- `auth_identities`: maps OAuth providers to `person_id`.

## Phone OTP
- `POST /auth/otp/start` issues 6-digit OTP in Redis (`otp:phone:{e164}`) and sends via SMS.
- `POST /auth/otp/verify` validates OTP, marks phone verified, returns JWT.

## Merge Flow
- Start: `POST /identity/merge/start` with target verified phone.
- Confirm: `POST /identity/merge/confirm` with merge token.
- Auto-link only on verified phone match; no email auto-link.
