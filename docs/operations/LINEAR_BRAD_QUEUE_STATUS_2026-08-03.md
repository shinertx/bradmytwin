# Linear Brad Queue Status

Date: 2026-08-04

## Verified State

- Linear connector: installed and authenticated.
- Linear team: `Brad`.
- Linear project: [Brad Non-JENNI Operating Queue](https://linear.app/bradforben/project/brad-non-jenni-operating-queue-2eafa8f183cd).
- Imported issues: 35 active non-JENNI task cards.
- Native control issues: 2 (`BRA-40` Kimi cutover and `BRA-41` command-loop canary).
- Total project issues mirrored into Brad/Postgres: 37.
- Parked cards: 5; retained in the canonical reconciliation manifest and intentionally excluded from the active Linear queue.
- JENNI candidates excluded: 612.

## System Boundary

The imported 35-card source set remains `/Users/benjijmac/workspace-audits/NON_JENNI_TASK_RECONCILIATION_2026-08-03.json`. Linear is now Ben's single human command board for non-JENNI work. Brad/Postgres remains the hidden machine ledger for objectives, leases, attempts, approvals, receipts, and proof. OpenClaw remains the current channel runtime; Hermes is a bounded specialist worker.

The historical import is still checked as a 35-card reconciliation subset. Native Linear control issues are intentionally ignored by that shadow parity check unless they carry a reconciliation ID.

## How To Run Hermes From Linear

1. Put the issue in `In Progress`.
2. Add `Hermes`.
3. Add `Brad Run`.

That combination creates one digest-keyed, read-only Hermes analysis job. Changing the issue creates a new digest only when the source content actually changes. Removing labels does not erase prior receipts.

An ordinary Hermes result posts a receipt but does not move the issue to `Done`. Only independently verified evidence can complete real work. `Brad Canary` is a restricted synthetic verifier used only for command-loop tests.

## Controls

- Every imported issue carries a reconciliation ID and next action.
- External writes, legal actions, payments, credentials, messages, and deletions remain approval-gated.
- Blocked work is placed in Linear Backlog rather than presented as ready to execute.
- Sensitive legal/probation content was reduced to minimum metadata; source documents remain private/local.
- No JENNI work was imported.
- Automated Hermes runs expose only the `clarify` toolset. Linear cannot authorize terminal, file, browser, message, payment, deployment, credential, deletion, legal, or other external-effect tools.

## Proof

Linear readback returned the original 35 reconciliation issues plus two native control issues. All 37 are mirrored into Brad/Postgres. Current objective state is 5 blocked, 31 intaked, and 1 verified synthetic canary.

`BRA-41` proved the complete Linear to Brad to Hermes to receipt loop. The first attempt timed out and became `RECONCILE_REQUIRED`; Brad did not retry an ambiguous run. The corrected attempt used `openai-codex` / `gpt-5.4-mini`, the `clarify` toolset, session `20260804_085230_a47622`, and artifact digest `31041a5e6aa6d307ee803e0deebd63a1ac259bdb191521466a84cc9e2b875cc1`. Its verified receipt comment and `Done` transition were each projected once.
