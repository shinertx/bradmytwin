#!/bin/sh
set -eu
umask 077

ROOT="${1:-$HOME/server-audits/brad-baseline-$(date -u +%Y%m%dT%H%M%SZ)}"
HOST="${BRAD_SSH_HOST:-meme-snipe-v19-vm}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REMOTE_BACKUP_ROOT="${BRAD_REMOTE_BACKUP_ROOT:-\$HOME/backups/brad/pre-multi-agent-$STAMP}"
mkdir -p "$ROOT"

git rev-parse HEAD > "$ROOT/repo-head.txt"
git status --short --branch > "$ROOT/repo-status.txt"

curl -fsS http://127.0.0.1:8181/_readiness > "$ROOT/buzz-readiness.json" 2>&1 || true
buzz --version > "$ROOT/buzz-version.txt" 2>&1 || true
defaults read /Applications/Buzz.app/Contents/Info CFBundleShortVersionString \
  > "$ROOT/buzz-desktop-version.txt" 2>&1 || true
find "$HOME/.config/buzz" -maxdepth 3 -type f \
  \( -path '*/keys/*' -o -name 'managed-agents.json' -o -name 'brad-agent-system.md' \) \
  -exec sh -c 'for file do printf "%s\t%s\t" "$(stat -f %z "$file")" "$(shasum -a 256 "$file" | cut -d" " -f1)"; printf "%s\n" "${file#"$HOME"/}"; done' sh {} + \
  | sort > "$ROOT/buzz-identity-manifest.txt" 2>/dev/null || true

ssh "$HOST" 'set -eu
  printf "captured_at="; date -u +%Y-%m-%dT%H:%M:%SZ
  printf "host="; hostname
  for unit in openclaw-gateway brad-api brad-web brad-worker brad-linear-hermes hermes-dashboard; do
    printf "%s active=" "$unit"; systemctl --user is-active "$unit" 2>/dev/null || true
    printf "%s enabled=" "$unit"; systemctl --user is-enabled "$unit" 2>/dev/null || true
  done
' > "$ROOT/remote-services.txt"

ssh "$HOST" 'systemctl --user show openclaw-gateway brad-api brad-web brad-worker brad-linear-hermes hermes-dashboard \
  -p Id -p FragmentPath -p ExecStart -p ActiveState -p SubState -p MainPID -p NRestarts --no-pager' \
  > "$ROOT/remote-service-metadata.txt"

ssh "$HOST" 'for f in "$HOME/.openclaw/openclaw.json" "$HOME/.config/systemd/user/openclaw-gateway.service" \
  "$HOME/.config/systemd/user/brad-api.service" "$HOME/.config/systemd/user/brad-worker.service"; do
  if [ -f "$f" ]; then sha256sum "$f"; fi; done' > "$ROOT/remote-config-hashes.txt"

ssh "$HOST" 'docker ps --format "{{.Names}}\t{{.Image}}\t{{.Status}}" 2>/dev/null || true' > "$ROOT/remote-containers.txt"

ssh "$HOST" "set -eu
  backup_root=\"$REMOTE_BACKUP_ROOT\"
  mkdir -p \"\$backup_root\"
  chmod 700 \"\$backup_root\"
  docker exec brad-postgres pg_dump -U postgres -d brad -Fc > \"\$backup_root/brad.dump\"
  chmod 600 \"\$backup_root/brad.dump\"
  docker exec -i brad-postgres pg_restore --list < \"\$backup_root/brad.dump\" >/dev/null
  sha256sum \"\$backup_root/brad.dump\"
  stat -c 'bytes=%s mode=%a path=%n' \"\$backup_root/brad.dump\"
" > "$ROOT/remote-database-backup.txt"

cat > "$ROOT/rollback.txt" <<'EOF'
Rollback keeps evidence and disables only the new execution path:
1. Set BRAD_CONDUCTOR_MODE=shadow for brad-api and brad-worker.
2. Restart brad-api and brad-worker.
3. Stop the Mac buzz bridge.
4. Keep agent/objective tables intact for reconciliation and audit.
5. Confirm OpenClaw readiness, Brad API health, and one no-delivery model canary before restoring channel traffic.
EOF

find "$ROOT" -type f ! -name manifest.sha256 -exec shasum -a 256 {} \; | sort > "$ROOT/manifest.sha256"
printf '%s\n' "$ROOT"
