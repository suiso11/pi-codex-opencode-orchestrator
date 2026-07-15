#!/usr/bin/env bash
set -euo pipefail

model="${PI_CODEX_MODEL:-openai-codex/gpt-5.5}"

exec pi \
  --approve \
  --model "$model" \
  --thinking high \
  --tools read,grep,find,ls,bash,opencode_task,opencode_spawn,opencode_wait,opencode_check,opencode_cancel,opencode_list,opencode_workflow,opencode_workflow_wait,opencode_workflow_check,opencode_workflow_cancel,opencode_workflow_list \
  "$@"
