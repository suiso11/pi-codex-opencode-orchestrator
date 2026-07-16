# Pi Codex OpenCode Orchestrator

A lightweight [Pi coding agent](https://github.com/earendil-works/pi) extension that uses Codex as the primary orchestrator and OpenCode as a bounded worker backend.

It adds background task control, safe parallel scheduling for declared file scopes, and phased workflows without depending on Claude/Anthropic models.

## Features

- `opencode_spawn`, `opencode_wait`, `opencode_check`, `opencode_cancel`, and `opencode_list`
- Global limit of four running OpenCode workers
- Overlapping read-only tasks can run concurrently
- Write tasks can run concurrently only when their declared concrete paths do not overlap
- Two-or-more-phase workflows for genuinely dependent work
- Bounded handoff of previous-phase results to the next phase
- Background result delivery through Pi follow-up messages
- Timeout handling, SIGTERM/SIGKILL cleanup, and bounded output capture
- Default worker model: `opencode-go/glm-5.2`

## Requirements

- Node.js 22 or newer
- Pi with a configured Codex/OpenAI provider
- OpenCode CLI with access to the selected worker model
- Codex CLI for optional GPT-5.5 review subagents

Install Pi and OpenCode according to their upstream documentation, then authenticate each provider before starting the launcher.

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.80.7
npm install -g opencode-ai@1.18.2
npm install -g @openai/codex
```

## Quick start

```bash
git clone https://github.com/suiso11/pi-codex-opencode-orchestrator.git
cd pi-codex-opencode-orchestrator
npm install
scripts/pi_codex_orchestrator.sh
```

On Windows PowerShell, use:

```powershell
.\scripts\pi_codex_orchestrator.ps1
```

On the first Pi run, use `/login` and select the Codex/OpenAI provider. The launcher defaults to `openai-codex/gpt-5.5` for the parent agent.

You can override both models:

```bash
PI_CODEX_MODEL=openai-codex/gpt-5.5 \
PI_OPENCODE_MODEL=opencode-go/glm-5.2 \
scripts/pi_codex_orchestrator.sh
```

Other settings:

- `PI_OPENCODE_BIN`: OpenCode executable, default `opencode`
- `PI_OPENCODE_TIMEOUT_MS`: timeout per worker, default 600000 ms, maximum 30 minutes
- `/opencode-status`: show the current worker configuration inside Pi

## Worker models

Routine OpenCode tasks use `opencode-go/glm-5.2`. Set `profile: "qwen_max"` on a task or workflow task for complex or large-context implementation; it resolves to `opencode-go/qwen3.7-max`. An explicit `model` always takes precedence over `profile`.

Override the profile model when needed:

```bash
PI_OPENCODE_PROFILE_QWEN_MAX=opencode-go/qwen3.7-max \
scripts/pi_codex_orchestrator.sh
```

GPT-5.5 review subagents run through Codex CLI, not OpenCode:

```bash
codex exec -m gpt-5.5 --sandbox read-only "$(cat /tmp/codex_prompt.md)"
```

The currently available OpenCode Go catalog exposes Qwen3.7 Max rather than Qwen3.6 Max.

## Using it in another repository

Copy the extension directory into that repository:

```bash
mkdir -p /path/to/project/.pi/extensions
cp -R .pi/extensions/opencode-orchestrator /path/to/project/.pi/extensions/
```

You may also copy `scripts/pi_codex_orchestrator.sh` or launch Pi with the same tool allowlist shown in that script.

## Task model

Each worker receives a structured objective, mode, relevant paths, constraints, and expected output.

Tasks may also select the `qwen_max` profile. Direct `model` overrides remain available for any OpenCode provider/model ID.

- `read_only`: file changes are forbidden; overlapping research scopes are allowed.
- `write`: changes are limited to declared paths. Concurrent tasks are rejected when scopes are identical or have a parent/child relationship.
- `opencode_workflow`: requires at least two sequential phases. Tasks inside one phase fan out under the same global four-worker cap.

Path enforcement is a scheduler and prompt-level guard, not an operating-system sandbox. The parent Codex agent must still inspect the final diff and run relevant tests.

## Development

```bash
npm test
npm run typecheck
```

The tests cover scope normalization, write-conflict detection, the four-worker cap, cancellation, parallel execution, workflow sequencing, and previous-phase context handoff.

## Design note

The project was informed by the multi-backend ideas in [davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup), but is an independent, focused implementation using Node.js standard process APIs rather than its Effect-based subagent framework.
