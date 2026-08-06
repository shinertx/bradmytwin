# Kimi Claw Cutover Checklist

Status: Planned candidate; not cut over

## Architectural Rule

Brad remains the control plane. Kimi Claw may replace the current OpenClaw model/channel runtime, but it must not own durable objective state, approval authority, external-effect reconciliation, or completion verification.

## Current Baseline

On 2026-08-04, a no-delivery OpenClaw canary used agent `brad-runtime` and returned the exact marker `OPENCLAW_MODEL_CANARY_OK` through `openai/gpt-5.5` in 13.389 seconds. Run ID: `16acce37-5b6c-4655-ab5b-d6edc9ab9b5b`. No fallback or external delivery occurred.

This proves only the current model path. Kimi remains uninstalled and has not passed model parity, identity isolation, approval pause/resume, connector delivery, restart recovery, or rollback rehearsal.

## Required Inputs

- Exact Kimi Claw product and account.
- Supported API or gateway endpoint.
- Authentication method.
- Session and conversation identifiers.
- Tool schema and tool-result continuation format.
- Channel integration details.
- Rate, usage, and data-retention terms.

## Shadow Test

Run the same read-only prompt through OpenClaw and Kimi Claw. Kimi passes only if it returns the expected answer, preserves the correct person/session boundary, produces inspectable logs, and makes no external write.

## Approval Test

Submit a synthetic write request. Kimi passes only if Brad creates an approval request before execution, binds the approval to the exact payload, and Kimi can resume after a tool result without executing the action twice.

## Recovery Test

Interrupt the runtime after the request is recorded but before completion. Kimi passes only if Brad recovers the objective without losing it, duplicating the effect, or claiming completion without a receipt.

## Channel Test

Complete one fresh inbound and outbound round trip on the intended channel. Channel connectivity is separate from runtime, worker, and approval proof.

## Cutover Gate

Cut over only after all tests pass and a rollback command is documented. Keep OpenClaw installed but inactive during the initial Kimi observation window. Do not remove OpenClaw state, credentials, or logs during the cutover.

## Rollback Trigger

Roll back immediately for cross-person context, an unapproved write, a duplicated effect, a lost objective, an unverifiable completion, or repeated channel failure.
