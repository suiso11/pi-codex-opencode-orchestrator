#!/usr/bin/env bash
set -euo pipefail

model="${PI_CODEX_MODEL:-openai-codex/gpt-5.6-sol}"
thinking="${PI_CODEX_THINKING:-medium}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
extension="$script_dir/../.pi/extensions/opencode-orchestrator/index.ts"

runtime="${PI_ORCH_RUNTIME:-omp}"
case "$runtime" in
  omp)
    extension="$script_dir/../.pi/extensions/opencode-orchestrator/omp.ts"
    runtime_args=(--allow-home --no-extensions --config "$script_dir/omp-orchestrator.yml")
    tools="read,grep,glob,task,wait,opencode_task,opencode_spawn,opencode_wait,opencode_tools"
    ;;
  pi)
    runtime_args=(--approve)
    tools="read,grep,find,ls,opencode_task,opencode_spawn,opencode_wait,opencode_tools"
    ;;
  *) echo "PI_ORCH_RUNTIME must be omp or pi" >&2; exit 2 ;;
esac

exec "$runtime" \
  "${runtime_args[@]}" \
  --extension "$extension" \
  --model "$model" \
  --thinking "$thinking" \
  --tools "$tools" \
  "$@"
