#!/usr/bin/env bash
set -euo pipefail

model="${PI_CODEX_MODEL:-openai-codex/gpt-5.6-sol}"
thinking="${PI_CODEX_THINKING:-high}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
extension="$script_dir/../.pi/extensions/opencode-orchestrator/index.ts"

exec pi \
  --approve \
  --extension "$extension" \
  --model "$model" \
  --thinking "$thinking" \
  --tools read,grep,find,ls,bash,subagent,subagent_resume,subagent_kill,opencode_task,opencode_spawn,opencode_wait,opencode_check,opencode_cancel,opencode_list,opencode_output,opencode_workflow,opencode_workflow_wait,opencode_workflow_check,opencode_workflow_cancel,opencode_workflow_list \
  "$@"
