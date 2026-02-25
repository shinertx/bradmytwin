# Identity and Auth

## Canonical Identity
`person_id` is the tenant boundary.

## Identity Graph
- `channel_identities`: maps channel user keys to `person_id`.
- `auth_identities`: maps OAuth providers to `person_id`.

## Phone OTP
- `POST /auth/otp/start` issues 6-digit OTP in Redis (`otp:phone:{e164}`) and sends via SMS.
- `POST /auth/otp/verify` validates OTP, marks phone verified, returns JWT.
- `POST /auth/phone/start` and `POST /auth/phone/verify` are web-friendly aliases; `/auth/phone/verify` can attach phone to an already logged-in Google user.

## Google Login (Web)
- `GET /auth/login/google/start` starts OAuth with `openid email profile`.
- `GET /auth/login/google/callback` resolves/creates person via `auth_identities(provider='GOOGLE')`.
- Callback issues one-time Redis exchange token (`auth:google:exchange:{code}`, TTL 60s).
- `POST /auth/login/google/exchange` consumes exchange token and returns JWT.

## Merge Flow
- Start: `POST /identity/merge/start` with target verified phone.
- Confirm: `POST /identity/merge/confirm` with merge token.
- Auto-link only on verified phone match; no email auto-link.
