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
- EA signal ingestion classifies email/SMS/calendar/portal/manual inputs and creates tasks for actionable signals.
- EA dashboard remains scoped by `person_id` and does not expose another user's signals, tasks, monitors, or source records.
- `phone.call_agent` creates a `PLACE_PHONE_CALL` approval instead of calling immediately.
- Worker starts the Call-E run only after approval and returns the run payload; `phone.get_call_status` can read a known `run_id`.
- `phone.call_ivr` creates a `PLACE_PHONE_CALL` approval instead of calling immediately; after approval, the worker starts a Twilio Voice call with the approved DTMF sequence and `phone.get_ivr_call_status` can read a known call SID.

## End-to-End Acceptance
1. User A (phone A) and User B (phone B) onboard independently.
2. User A sends scheduling request and receives approval prompt.
3. User A approves via web and receives completion notification.
4. User A calendar/gmail write is reflected in Google account after approval.
5. User B cannot access A approvals, messages, or connector metadata.
6. Telegram-originated user can verify phone and link to same account.
7. Email/SMS/calendar signals appear in the Control Tower and actionable items show in Today or Waiting.
8. A phone-agent or IVR request cannot place a live call until User A approves the specific destination, goal, and keypad sequence when present.

## Load/Isolation
- Concurrent multi-user messages with no cross-thread payload leakage.
- Single-user burst messages are serialized by lock.
