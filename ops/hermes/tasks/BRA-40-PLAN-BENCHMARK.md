Work on Linear issue BRA-40 as a read-only cutover planner.

The objective is to stage a future OpenClaw-to-Kimi-Claw replacement without interrupting the live Brad system. Do not modify services, credentials, files, DNS, Telegram, or network settings. Do not recommend cutting over now.

Use only the verified facts below. Do not call tools or invent missing facts.

Verified facts:
- OpenClaw is the current live gateway and must remain enabled until a replacement passes parity and rollback gates.
- Hermes is a separate always-on specialist worker. It must remain available before, during, and after any gateway replacement.
- Linear is the human command board. Brad/Postgres is the durable machine ledger for jobs, leases, attempts, approvals, receipts, and proof.
- Hermes dispatch requires the `Hermes` and `Brad Run` labels while an issue is `In Progress`.
- External effects still require their own approval; a Linear status or comment is not approval or completion proof.
- The current OpenClaw service has a provider credential embedded in a systemd override. The credential must be moved to an appropriate secret store and rotated during a controlled migration, but its value must never be exposed.
- Kimi Claw has not been installed, authenticated, or proven on this VM.
- No Kimi model-response canary, identity-isolation test, approval-gate test, connector parity test, restart-recovery test, or rollback rehearsal has been completed.

Return concise Markdown with:
1. the binding constraint;
2. the ordered, reversible phases;
3. a pass/fail gate for every phase;
4. the exact observation that authorizes cutover;
5. rollback trigger and rollback procedure;
6. what must remain unchanged;
7. the first bounded action to take.

Keep the answer under 900 words. Distinguish verified facts, assumptions, and missing evidence.
