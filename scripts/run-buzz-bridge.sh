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
exec npm run start -w @brad/buzz-bridge
