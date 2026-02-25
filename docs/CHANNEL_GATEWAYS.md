# Channel Gateways

## Interface
Each gateway implements:
- `receiveInbound(payload)`
- `sendOutbound(message)`
- `normalizeIdentity(inbound)`
- `validateSignature(input)`

## Implementations
- `TwilioSmsGateway`
- `TwilioWhatsAppGateway`
- `MetaWhatsAppGateway`
- `TelegramGateway`
- `WebGateway`

## Security
- Twilio signatures validated with `X-Twilio-Signature` when auth token configured.
- Meta webhook verification uses `hub.verify_token` challenge and `X-Hub-Signature-256` (HMAC-SHA256) when app secret is configured.
- Telegram webhook secret validated against `X-Telegram-Bot-Api-Secret-Token`.

## Identity Inputs
- SMS/WhatsApp: phone number anchors identity.
- Telegram: chat/user ID used; phone verification required for anchor.
- Web: `person_id` from verified JWT.
