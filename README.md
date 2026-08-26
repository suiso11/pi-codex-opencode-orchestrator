# Pi Codex OpenCode Orchestrator

A lightweight [Pi coding agent](https://github.com/earendil-works/pi) extension that uses Codex as the primary orchestrator and OpenCode as a bounded worker backend.

It adds background task control, safe parallel scheduling for declared file scopes, and phased workflows without depending on Claude/Anthropic models.

## Features

- `opencode_spawn`, `opencode_wait`, `opencode_check`, `opencode_cancel`, `opencode_list`, and `opencode_output`
- Dynamic `opencode_tools` groups that additively activate optional inspection/control/workflow tools per session
- Global limit of four running OpenCode workers
- Overlapping read-only tasks can run concurrently
- Write tasks can run concurrently only when their declared concrete paths do not overlap
- Two-or-more-phase workflows for genuinely dependent work
- Bounded handoff of previous-phase results to the next phase
- Background result delivery through Pi follow-up messages, batched into one follow-up after all currently running background tasks and workflows settle
- Structured worker reports with `summary`, `files`, `findings`, and `unresolved` fields
- Timeout handling, SIGTERM/SIGKILL cleanup, and bounded output capture
- Up to 120k characters of raw output retained per worker; normal parent delivery capped at 8k; workflow handoff compact JSON capped at 4k
- `opencode_output` escape hatch to fetch a retained raw output slice on demand when the compact preview is insufficient
- Dedicated one-turn context pruning: old orchestration results are replaced with a short placeholder for the parent model, while session history and the manager's retained raw output stay intact
- `/opencode-usage` reports actual parent and worker token usage plus workflow handoff duplication and latest pruning statistics, with no savings claim absent a baseline
- Default worker model: `opencode-go/glm-5.2`
- Medium thinking by default for parent and workers, with per-task `low|medium|high` overrides
- Interactive `/orch-model` command for persistent parent and worker model changes
- Live Pi widget with each running worker's model, elapsed time, mode, task name, and latest activity

## Requirements

- Node.js 22 or newer
- Pi with a configured Codex/OpenAI provider
- OpenCode CLI with access to the selected worker model
- Codex CLI for optional GPT-5.6 Sol final-review subagents

Install Pi and OpenCode according to their upstream documentation, then authenticate each provider before starting the launcher.

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.2
npm install -g opencode-ai@1.18.18
npm install -g @openai/codex
```

## Quick start

For setup on additional PCs, configuration sharing, and update procedures, see [docs/multi-pc-setup.ja.md](docs/multi-pc-setup.ja.md) (Japanese).

```bash
git clone https://github.com/suiso11/pi-codex-opencode-orchestrator.git
cd pi-codex-opencode-orchestrator
npm install
npm link
pi-orch
```

`npm link` registers the `pi-orch` command globally. After that, launch the orchestrator from any directory with:

```bash
pi-orch
```

You can still run `scripts/pi_codex_orchestrator.sh` directly, or
`.\scripts\pi_codex_orchestrator.ps1` on Windows PowerShell, without creating the global command.

On the first Pi run, use `/login` and select the Codex/OpenAI provider. The launcher defaults to `openai-codex/gpt-5.6-sol` for the parent and final approval.

You can override both models:

```bash
PI_CODEX_MODEL=openai-codex/gpt-5.6-sol \
PI_OPENCODE_MODEL=opencode-go/glm-5.2 \
pi-orch
```

Other settings:

- `PI_OPENCODE_BIN`: OpenCode executable, default `opencode`
- `PI_OPENCODE_TIMEOUT_MS`: timeout per worker, default 600000 ms, maximum 30 minutes
- `PI_CODEX_THINKING`: parent thinking level, default `medium`; set `high` for final risky approval or complex planning
- `PI_OPENCODE_THINKING`: default worker thinking level, default `medium`; each task accepts a per-task `thinking` of `low|medium|high`
- `/opencode-status`: show the current worker configuration inside Pi
- `/opencode-usage`: report actual parent and worker token usage plus workflow handoff duplication

Medium is the cost-aware default for both parent and workers, not a guarantee of sufficiency. Ambiguous, risky, or final-approval work should opt into `high` (via `PI_CODEX_THINKING=high` for the parent, or a per-task `thinking: high` for a dedicated review worker).

Change models interactively inside Pi:

```text
/orch-model
```

The command can also be used directly:

```text
/orch-model show
/orch-model parent openai-codex/gpt-5.6-sol
/orch-model worker opencode opencode-go/glm-5.2
/orch-model glm pi anthropic/claude-sonnet-4-5
/orch-model kimi pi openai-codex/gpt-5.6-sol
/orch-model reset worker
```

For worker routes, `opencode` runs the OpenCode CLI and `pi` bypasses OpenCode completely, using Pi's authenticated providers directly. Selections are saved to the per-user `pi-orch/models.json` config and apply immediately to the parent or to newly started workers.

## Live activity dashboard

While worker tasks are running, Pi shows a widget above the editor. It refreshes about once per second and includes:

- running worker and workflow counts
- each worker ID, backend, full model ID, elapsed time, mode, task name, and latest activity
- each workflow ID, elapsed time, and current phase

The widget disappears automatically when no OpenCode work remains. The compact footer status and `/opencode-status` command remain available.

## Worker backends and models

Each worker route can use either the OpenCode backend or the Pi backend. The Pi backend launches a bounded, non-interactive Pi worker with the selected Pi provider/model and never starts OpenCode. Read-only Pi workers receive only read/search tools; write workers receive the editing toolset.

The default routes remain `opencode-go/glm-5.2` and `opencode-go/kimi-k3`. The profile names are compatibility aliases and do not force those model families.

Override either profile when needed:

```bash
PI_OPENCODE_PROFILE_GLM=opencode-go/glm-5.2 \
PI_OPENCODE_PROFILE_KIMI_K3=opencode-go/kimi-k3 \
pi-orch
```

Final approval remains with GPT-5.6 Sol through the parent or a separate Codex CLI review:

```bash
codex exec -m gpt-5.6-sol --sandbox read-only "$(cat /tmp/codex_prompt.md)"
```

Kimi K3 provides a different review perspective but does not grant final approval.

## Tool capability routing

OpenCode workers do not inherit ambient OpenCode config. The parent owns the worker tool set via **tool profiles** and per-model **capability metadata**, so provider-specific limits (e.g. `deepseek-v4-flash`'s 16-tool / restricted-schema constraint) never surface as opaque aborts.

### Tool profiles

Pass `tool_profile` on `opencode_task` / `opencode_spawn`:

| Profile | Tools | Notes |
| --- | --- | --- |
| `minimal` | read, glob, grep | read-only recon |
| `coding` | read, glob, grep, edit, bash | **default**; `read_only` mode auto-strips edit/bash |
| `research` | read, glob, grep, webfetch, websearch | investigation with web access |
| `full` | every OpenCode tool | explicit opt-in only |

Pi workers always pass explicit `--tools` and ignore `tool_profile`.

### Model capability metadata

Built-in:

```ts
opencode-go/deepseek-v4-flash: { maxTools: 16, toolSchema: "restricted" }
```

Override or extend from the environment (model slashes as `__`):

```bash
PI_OPENCODE_MODEL_CAP_opencode-go__deepseek-v4-flash=maxTools=8,toolSchema=restricted
```

When a profile's tool count exceeds `maxTools`, the manager trims to the limit and records a `capability:` notice in worker activity.

### How it reaches OpenCode

OpenCode resolves agents by **name** from `~/.config/opencode/agent/<name>.md`. Per spawn, the manager writes a frontmatter-only agent definition with `permission:` deny blocks for tools outside the profile, passes `--agent <name>`, and removes the file on close/timeout. The parent decides the tool set; ambient global/project/`.opencode` config no longer affects worker tool availability.


## Using it in another repository

Copy the extension directory into that repository:

```bash
mkdir -p /path/to/project/.pi/extensions
cp -R .pi/extensions/opencode-orchestrator /path/to/project/.pi/extensions/
```

You may also copy `scripts/pi_codex_orchestrator.sh` or launch Pi with the same tool allowlist shown in that script.

## Task model

Each worker receives a structured objective, mode, relevant paths, constraints, and expected output.

Tasks may select the `glm` or `kimi_k3` profile. Direct `model` overrides remain available for any OpenCode provider/model ID.

- `read_only`: file changes are forbidden; overlapping research scopes are allowed.
- `write`: changes are limited to declared paths. Concurrent tasks are rejected when scopes are identical or have a parent/child relationship.
- `opencode_workflow`: requires at least two sequential phases. Tasks inside one phase fan out under the same global four-worker cap.

Path enforcement is a scheduler and prompt-level guard, not an operating-system sandbox. The parent Codex agent must still inspect the final diff and run relevant tests.

## Routing and token-aware delivery

### When to delegate vs. stay on the parent

- Trivial one-read or tiny one-file work stays on the parent. Do not spawn a worker for it.
- Bounded, mechanical work (scoped implementation, test additions, docs updates) delegates to a worker.
- Broad independent research parallelizes across multiple `opencode_spawn` workers (up to four).
- Ambiguous, risky, or final-review work stays on the parent. Use `PI_CODEX_THINKING=high` (or a per-task `thinking: high` for a dedicated review worker) for these; `medium` is the cost-aware default, not a guarantee of sufficiency.

### Compact results and raw output

Each worker returns a structured report with `summary`, `files`, `findings`, and `unresolved` fields, targeting roughly 2–4k characters. The extension retains up to 120k characters of raw worker output, but normal delivery to the parent is capped at 8k characters, and workflow phase handoffs pass a compact JSON blob capped at 4k characters. When the compact preview is insufficient, call `opencode_output` with an offset/limit to fetch a retained raw slice on demand.

### Batched background delivery

Background completions are not delivered one-by-one. When the parent is idle and no background tasks or workflows remain running, settled workers and workflows are batched into a single follow-up message (capped at 8k). This avoids many small follow-ups interrupting the parent.

### One-turn result retention and context pruning

To stop the parent model from repeatedly re-reading large orchestration results, the extension hooks Pi's `context` event and replaces the model-facing content of **old** orchestration results with a short deterministic placeholder. Targets are `opencode_*` tool results and `opencode-batch-result` custom messages. A result is pruned only once it appears before the latest real user-role message, so the current turn's freshly returned worker result or background batch remains fully available for the immediate next model call and is pruned starting with the next user turn. Message ordering, roles, tool call IDs, tool names, and non-target messages are preserved; useful task/workflow IDs are kept in the placeholder when available from the result details.

Pruning is non-destructive: the session JSONL and the manager's retained raw output are never changed, and `opencode_output` can still fetch any retained slice on demand. `/opencode-usage` reports the latest outbound request's pruned-message count and characters removed, avoiding repeated counting of the same historical messages.

### Dynamic tool groups

The core orchestration tools `opencode_task`, `opencode_spawn`, `opencode_wait`, and `opencode_tools` (plus unrelated tools owned by Pi and other extensions) are always active. Optional tools — `opencode_check`, `opencode_cancel`, `opencode_list`, `opencode_output`, and the `opencode_workflow*` family — start inactive to keep the system prompt lean and prompt caching stable, and are loaded on demand:

```text
opencode_tools group=inspection
opencode_tools group=control
opencode_tools group=workflows
opencode_tools group=all
```

Activation is additive and persists for the session: each group turns on its set without disabling anything else, and the loader returns a compact loaded/already-active status. On each `session_start` the extension reapplies the compact initial active set. Use `opencode_tools group=inspection` (or `all`) before calling `opencode_output` on demand to fetch a retained raw output slice.

### Usage reporting

`/opencode-usage` reports actual parent and worker token usage plus workflow handoff duplication (unique chars created vs. chars injected downstream, with a duplication ratio). Totals are observed usage only; no baseline comparison is available, so token savings are not claimed.

## Development

```bash
npm test
npm run typecheck
```

The tests cover scope normalization, write-conflict detection, the four-worker cap, cancellation, parallel execution, workflow sequencing, previous-phase context handoff, and one-turn orchestration context pruning.

## Design note

The project was informed by the multi-backend ideas in [davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup), but is an independent, focused implementation using Node.js standard process APIs rather than its Effect-based subagent framework.
