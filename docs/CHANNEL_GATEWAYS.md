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
- `TelegramGateway`
- `WebGateway`

## Security
- Twilio signatures validated with `X-Twilio-Signature` when auth token configured.
- Telegram webhook secret validated against `X-Telegram-Bot-Api-Secret-Token`.

## Identity Inputs
- SMS/WhatsApp: phone number anchors identity.
- Telegram: chat/user ID used; phone verification required for anchor.
- Web: `person_id` from verified JWT.
