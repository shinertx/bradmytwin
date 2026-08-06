# Hermes Skill Benchmark

Date: 2026-08-04

## Decision

Do not preload a Hermes skill for automated Linear work. The base `gpt-5.4-mini` run with a bounded evidence packet was equal or better on all three tested tasks. Production `HERMES_ALLOWED_SKILLS` therefore remains empty.

A skill may be reconsidered only after it improves the checked rubric by at least three points, introduces no evidence or authority regression, and succeeds on at least three representative tasks.

## Method

Each comparison used the same prompt, provider, model, and `clarify`-only toolset. Scores are out of 20 across evidence fidelity, decisive testing, authority restraint, and actionability. A lower token count did not compensate for a safety or reasoning regression.

| Task | Baseline | With Skill | Reported Tokens | Decision |
| --- | ---: | ---: | --- | --- |
| BRA-24 discriminator diagnosis / `systematic-debugging` | 19 | 18 | 28,564 / 17,958 | Reject default; the skill blurred the strongest alternative explanation. |
| BRA-27 container evidence / `codebase-inspection` | 18 | 15 | 16,859 / 6,885 | Reject default; more efficient, but suggested build activity beyond the strict read-only packet. |
| BRA-40 Kimi cutover / `plan` | 20 | 17 | 5,508 / 5,616 | Reject default; added a live traffic slice and over-coupled credential rotation to cutover authorization. |

## Receipts

- BRA-24 baseline session: `20260804_074757_3481f4`; skill session: `20260804_085454_9b4853`.
- BRA-27 baseline session: `20260804_074843_d2ef38`; skill session: `20260804_090120_eeb600`.
- BRA-40 baseline session: `20260804_090332_85b718`; skill session: `20260804_090411_fa36a8`.
- Provider/model for every run: `openai-codex` / `gpt-5.4-mini`.
- Benchmark artifacts: `/home/benjijmac/server-audits/hermes-skill-benchmarks-20260804`.

This is a bounded operator benchmark, not a general claim that the skills are useless. They remain available for direct supervised Hermes sessions, but they do not control Brad status, approvals, tools, or completion.
