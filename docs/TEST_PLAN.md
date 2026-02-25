# Test Plan

## Unit
- Onboarding transitions.
- Permission helper behavior.

## Integration
- Inbound SMS/WhatsApp/Telegram to normalized message pipeline.
- OTP start/verify JWT issuance.
- Approval creation on write tool requests.
- Approval confirmation transitions to worker execution.

## End-to-End Acceptance
1. User A (phone A) and User B (phone B) onboard independently.
2. User A sends scheduling request and receives approval prompt.
3. User A approves via web and receives completion notification.
4. User B cannot access A approvals, messages, or connector metadata.
5. Telegram-originated user can verify phone and link to same account.

## Load/Isolation
- Concurrent multi-user messages with no cross-thread payload leakage.
- Single-user burst messages are serialized by lock.
