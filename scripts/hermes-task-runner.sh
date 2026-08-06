#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: hermes-task-runner.sh <task-id> <prompt-file> <output-dir>" >&2
  exit 64
fi

task_id=$1
prompt_file=$2
output_dir=$3
hermes_bin=${HERMES_BIN:-/home/benjijmac/.local/bin/hermes}
state_db=${HERMES_STATE_DB:-/home/benjijmac/.hermes/state.db}
model=${HERMES_MODEL:-gpt-5.4-mini}
provider=${HERMES_PROVIDER:-openai-codex}
skills=${HERMES_SKILLS:-none}
toolsets=${HERMES_TOOLSETS:-clarify}
context_file=${HERMES_CONTEXT_FILE:-/home/benjijmac/server-audits/HERMES_CURRENT_STATE.md}

mkdir -p "$output_dir"
usage_file="$output_dir/${task_id}-usage.json"
stdout_file="$output_dir/${task_id}-stdout.txt"
stderr_file="$output_dir/${task_id}-stderr.txt"
result_file="$output_dir/${task_id}-hermes-result.md"

before=$(sqlite3 "$state_db" "SELECT COALESCE(MAX(started_at), 0) FROM sessions;")

hermes_args=(
  --ignore-rules
  --toolsets "$toolsets"
  --provider "$provider"
  --model "$model"
  --usage-file "$usage_file"
)
if [[ "$skills" != "none" ]]; then
  hermes_args+=(--skills "$skills")
fi
prompt=$(<"$prompt_file")
if [[ -s "$context_file" ]]; then
  prompt="$(<"$context_file")

---

# Current Assignment

$prompt"
fi
hermes_args+=(--oneshot "$prompt")

set +e
"$hermes_bin" "${hermes_args[@]}" \
  >"$stdout_file" 2>"$stderr_file"
exit_code=$?
set -e

session_id=$(sqlite3 "$state_db" \
  "SELECT id FROM sessions WHERE started_at > $before ORDER BY started_at DESC LIMIT 1;")

if [[ -z "$session_id" ]]; then
  echo "Hermes created no session for $task_id" >&2
  exit 65
fi

sqlite3 "$state_db" \
  "SELECT content FROM messages WHERE session_id = '$session_id' AND role = 'assistant' AND active = 1 ORDER BY id DESC LIMIT 1;" \
  >"$result_file"

if [[ $exit_code -ne 0 ]]; then
  echo "Hermes exited $exit_code for $task_id (session $session_id)" >&2
  exit "$exit_code"
fi

if [[ ! -s "$result_file" ]]; then
  echo "Hermes returned an empty result for $task_id (session $session_id)" >&2
  exit 66
fi

python3 - "$usage_file" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    usage = json.load(handle)

if not usage.get("completed") or usage.get("failed"):
    raise SystemExit("Hermes usage record does not prove successful completion")
PY

printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$task_id" "$session_id" "$provider" "$model" "$skills" "$toolsets"
