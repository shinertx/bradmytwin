#!/bin/sh
set -eu

ENV_FILE="${BRAD_BUZZ_ENV_FILE:-$HOME/.config/brad/buzz-bridge.env}"
KEY_FILE="${BUZZ_CODEX_PRIVATE_KEY_FILE:-$HOME/.config/buzz/keys/codex.key}"
if [ ! -f "$ENV_FILE" ] || [ ! -f "$KEY_FILE" ]; then
  echo "missing protected Buzz configuration" >&2
  exit 1
fi

set -a
. "$ENV_FILE"
set +a

: "${BUZZ_BRIDGE_PUBKEY:?missing BUZZ_BRIDGE_PUBKEY}"
: "${BUZZ_CHANNEL_ID:?missing BUZZ_CHANNEL_ID}"
export BUZZ_PRIVATE_KEY="$(cat "$KEY_FILE")"
export BUZZ_RELAY_URL="${BUZZ_RELAY_URL:-ws://127.0.0.1:3100}"

exec /Applications/Buzz.app/Contents/MacOS/buzz-acp \
  --private-key "$BUZZ_PRIVATE_KEY" \
  --relay-url "$BUZZ_RELAY_URL" \
  --agent-owner "$BUZZ_BRIDGE_PUBKEY" \
  --agent-command /opt/homebrew/bin/codex-acp \
  --agent-args '' \
  --permission-mode dont-ask \
  --respond-to owner-only \
  --allowed-respond-to owner-only \
  --subscribe mentions \
  --channels "$BUZZ_CHANNEL_ID" \
  --system-prompt-file "$HOME/.config/buzz/brad-agent-system.md" \
  --multiple-event-handling queue \
  --max-turn-duration 300 \
  --idle-timeout 120 \
  --lazy-pool \
  --memory \
  --max-turns-per-session 50 \
  --session-title 'Brad Control Room / Codex Conductor'
