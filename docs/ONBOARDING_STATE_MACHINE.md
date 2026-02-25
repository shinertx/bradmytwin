# Onboarding State Machine

States:
1. `ASK_NAME`
2. `ASK_CONNECT_CALENDAR`
3. `ASK_CONNECT_EMAIL`
4. `CONFIRM_READY`
5. `ACTIVE`

Transition rules are implemented in `packages/domain/src/onboarding.ts`.

## Behavior
- Name is captured in `ASK_NAME`.
- Connector prompts accept `CONNECT ...` or `SKIP`.
- `READY` transitions to `ACTIVE`.
