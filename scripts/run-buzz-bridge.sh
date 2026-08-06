#!/bin/sh
set -eu
ENV_FILE="${BRAD_BUZZ_ENV_FILE:-$HOME/.config/brad/buzz-bridge.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "missing protected bridge environment: $ENV_FILE" >&2
  exit 1
fi
set -a
. "$ENV_FILE"
set +a
TOKEN_FILE="${BRAD_AGENT_BRIDGE_TOKEN_FILE:-$HOME/.config/brad/agent-bridge.token}"
if [ -z "${BRAD_AGENT_BRIDGE_TOKEN:-}" ] && [ -f "$TOKEN_FILE" ]; then
  BRAD_AGENT_BRIDGE_TOKEN="$(cat "$TOKEN_FILE")"
  export BRAD_AGENT_BRIDGE_TOKEN
fi
exec npm run start -w @brad/buzz-bridge
