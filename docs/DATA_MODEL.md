# Data Model

## Postgres Tables
- `persons`
- `channel_identities`
- `auth_identities`
- `threads`
- `messages`
- `permissions`
- `skills_enabled`
- `connectors`
- `approval_requests`
- `tool_invocations`
- `audit_logs`
- `runtime_sessions`
- `model_profiles`

Schema is defined in [`infra/postgres/init/001_schema.sql`](../infra/postgres/init/001_schema.sql).

## Redis Keys
- `otp:phone:{e164}` OTP codes
- `lock:person:{person_id}` request serialization lock
- `runtime:person:{person_id}` runtime reuse state
- `resume:approval:{approval_id}` deferred approval payload context
