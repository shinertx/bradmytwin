# Test Plan

## Unit
- Onboarding transitions.
- Permission helper behavior.

## Integration
- Inbound SMS/WhatsApp/Telegram to normalized message pipeline.
- OTP start/verify JWT issuance.
- OpenClaw `/v1/responses` run creation and tool-call parsing.
- Approval creation on write tool requests with stored resume context (`session_id`, `response_id`, `tool_call_id`).
- Approval confirmation transitions to worker queue, real write execution, and OpenClaw continuation.
- Connector callback exchanges real Google code and stores encrypted access/refresh tokens.

## End-to-End Acceptance
1. User A (phone A) and User B (phone B) onboard independently.
2. User A sends scheduling request and receives approval prompt.
3. User A approves via web and receives completion notification.
4. User A calendar/gmail write is reflected in Google account after approval.
5. User B cannot access A approvals, messages, or connector metadata.
6. Telegram-originated user can verify phone and link to same account.

## Load/Isolation
- Concurrent multi-user messages with no cross-thread payload leakage.
- Single-user burst messages are serialized by lock.
