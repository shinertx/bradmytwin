# Managed Kimi Telegram Cutover

## Authority

Telegram is a transport. Brad/Postgres remains authoritative for objectives, approvals, evidence, receipts, and completion. Exactly one OpenClaw gateway may poll a Telegram bot token at a time.

## Current Cutover Record

On 2026-08-06 the existing Telegram bot credential moved from the GCP rollback runtime to the managed Kimi Claw named `Brad`.

- The credential crossed the pinned, forced-command SSH bridge into a mode-`0600` token file.
- Source and destination SHA-256 digests matched without printing the credential.
- The expiring single-use grant was consumed before the credential was emitted.
- The bootstrap gateway operation is disabled unless `BRAD_ENABLE_TELEGRAM_BOOTSTRAP=true`; the live forced-command environment does not enable it.
- GCP `channels.telegram.enabled` is `false` and its Telegram account is absent from live channel status.
- Managed Kimi reports Telegram `configured=true`, `running=true`, `tokenSource=tokenFile`, `mode=polling`, with a successful bot probe.
- The GCP pre-cutover config is preserved at `/home/benjijmac/.openclaw/openclaw.json.pre-managed-telegram-cutover-20260806` with mode `0600`.

Do not delete the managed token file or the GCP config backup during the observation window.

## Pairing Gate

The first owner message must receive an OpenClaw pairing challenge. Approve only the expected Telegram account and then rerun a unique-marker round trip. A bot probe is not delivery proof.

Pairing grants DM access, but the managed runtime must also identify the exact human operator in `commands.ownerAllowFrom`. For a one-owner bot, use the same numeric ID as the explicit `channels.telegram.allowFrom` entry and keep the DM policy allowlisted. Do not use a wildcard. The bridge separately binds the selected Telegram account, owner ID, and matching private-chat ID with a versioned SHA-256 fingerprint; the fingerprint is an integrity assertion, not an authentication secret.

Success requires:

1. exactly one owner message;
2. exactly one managed-Kimi inbound event;
3. exactly one Brad response;
4. no polling conflict or duplicate response;
5. a matching durable Brad objective/thread record.

The managed plugin is not cut over merely because it loads. Its package and manifest versions must match, the installed source hash must match the reviewed commit, all adversarial identity tests must pass, and the live owner message must reach Postgres before model execution.

## Fail-Closed Rollback

If the managed channel fails, stop it before restoring GCP. Never start the GCP poller while the managed poller is still active.

On managed Kimi:

```bash
openclaw config set channels.telegram.enabled false --strict-json
openclaw gateway restart
openclaw channels status --json
```

Continue only after Telegram is absent or reports `running=false`.

On the GCP rollback host:

```bash
cp /home/benjijmac/.openclaw/openclaw.json.pre-managed-telegram-cutover-20260806 /home/benjijmac/.openclaw/openclaw.json
chmod 600 /home/benjijmac/.openclaw/openclaw.json
systemctl --user restart openclaw-gateway
openclaw channels status --probe --json
```

Rollback succeeds only when the GCP Telegram probe is healthy and managed Kimi remains inactive. If either side is ambiguous, keep both pollers stopped and reconcile before retrying.

## Credential Hygiene

The GCP OpenClaw model provider already uses a file-backed SecretRef. The redundant systemd drop-in that held a plaintext `NVIDIA_API_KEY` was moved to the protected service quarantine on 2026-08-06 and removed from the active unit environment. Rotate that provider credential through its issuer if exposure outside the protected host is suspected.
