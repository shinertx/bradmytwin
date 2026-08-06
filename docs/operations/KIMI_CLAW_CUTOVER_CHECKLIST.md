# Kimi Claw Cutover Checklist

Status: Linked beta candidate; production remains on stable OpenClaw

## Architectural Rule

Brad remains the control plane. Kimi Claw may replace the current OpenClaw model/channel runtime, but it must not own durable objective state, approval authority, external-effect reconciliation, or completion verification.

## Current Baseline

On 2026-08-04, a no-delivery OpenClaw canary used agent `brad-runtime` and returned the exact marker `OPENCLAW_MODEL_CANARY_OK` through `openai/gpt-5.5` in 13.389 seconds. Run ID: `16acce37-5b6c-4655-ab5b-d6edc9ab9b5b`. No fallback or external delivery occurred.

The official `kimi-claw` plugin `0.27.1` is now installed on the GCP runtime and the existing Brad instance is linked in Kimi. Stable OpenClaw `2026.7.1-2` accepts inbound Kimi messages but produces zero outbound blocks, so it is not a valid Kimi production path.

An isolated `2026.7.2-beta.7` runtime passed two bounded canaries on 2026-08-06:

- the Kimi channel delivered one visible response from a deterministic mock model; and
- the full Kimi UI -> OpenClaw beta -> authenticated K3 -> Kimi UI path returned the exact marker `KIMI_FULL_PATH_K3_CANARY_20260806_0707Z` once.

The K3 canary used a short-lived Kimi Code OAuth token through a SecretRef and removed the staged token after the test. This proves compatibility, not durable production authentication. Production remains on stable OpenClaw with `openai/gpt-5.5` until a renewable server credential and the remaining rollout gates pass.

## Remaining Inputs

- Renewable Kimi server authentication. A short-lived Kimi Code OAuth token is not sufficient for an unattended service.
- A stable OpenClaw release containing the beta channel-dispatch fix, or an explicitly accepted beta production window.
- A fresh approval pause/resume canary through the K3 path.
- A restart recovery canary while a K3-backed objective is in progress.
- Rate, usage, and data-retention terms.

## Shadow Test

Run the same read-only prompt through OpenClaw and Kimi Claw. Kimi passes only if it returns the expected answer, preserves the correct person/session boundary, produces inspectable logs, and makes no external write.

## Approval Test

Submit a synthetic write request. Kimi passes only if Brad creates an approval request before execution, binds the approval to the exact payload, and Kimi can resume after a tool result without executing the action twice.

## Recovery Test

Interrupt the runtime after the request is recorded but before completion. Kimi passes only if Brad recovers the objective without losing it, duplicating the effect, or claiming completion without a receipt.

## Channel Test

Complete one fresh inbound and outbound round trip on the intended channel. Channel connectivity is separate from runtime, worker, and approval proof.

Result on 2026-08-06: **PASS in isolated beta, FAIL in stable production**. The beta produced one visible K3 response. Stable received the same class of input but emitted zero final blocks.

## Cutover Gate

Cut over only after all tests pass and a rollback command is documented. Keep OpenClaw installed but inactive during the initial Kimi observation window. Do not remove OpenClaw state, credentials, or logs during the cutover.

## Rollback Trigger

Roll back immediately for cross-person context, an unapproved write, a duplicated effect, a lost objective, an unverifiable completion, or repeated channel failure.
