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
- Explicit worker roles: `implementer`, `tester`, and `reviewer` with role-specific tool sets, model profiles, and safety behavior
- Opt-in Executor MCP gateway for explicit OpenCode `implementer` tasks (`executor: true`) when `PI_ORCH_ENABLE_EXECUTOR=1`
- Fail-closed OpenCode worker configuration isolation with private per-spawn config/agent directories, `--pure`, and project-config disabled
- High thinking by default for parent and workers (quality-first), with per-task `low|medium|high` overrides; `low` remains available explicitly for speed, and the `reviewer` role always resolves to `high`
- Interactive `/orch-model` command for persistent parent and worker model changes applied to running sessions without restarting the orchestrator
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
- `PI_ORCH_ENABLE_EXECUTOR=1`: opt in to the Executor MCP gateway; `PI_EXECUTOR_BIN` optionally selects its executable (default `executor`)
- `PI_ORCH_WORKER_ENV_ALLOWLIST`: optional comma/space-separated additional environment variable names passed to worker children; workers otherwise receive only runtime variables such as `PATH`, `HOME`, data/auth paths, temp directories, locale, and `CI`
- `PI_CODEX_THINKING`: parent thinking level, default `high`; use `low` explicitly for faster responses
- `PI_OPENCODE_THINKING`: default worker thinking level, default `high`; each task accepts a per-task `thinking` of `low|medium|high`
- `/opencode-status`: show the current worker configuration inside Pi
- `/opencode-usage`: report actual parent and worker token usage plus workflow handoff duplication

High is the quality-first default for both parent and workers. Low remains available explicitly for faster, cost-aware responses when quality requirements allow it; per-task `thinking: low` and `PI_CODEX_THINKING=low`/`PI_OPENCODE_THINKING=low` are supported. The `reviewer` role always resolves to `high` regardless of the default.

Change models interactively inside Pi:

```text
/orch-model
```

The command can also be used directly:

```text
/orch-model show
/orch-model parent openai-codex/gpt-5.6-sol
/orch-model worker opencode opencode-go/glm-5.2
/orch-model implementer pi anthropic/claude-sonnet-4-5
/orch-model reviewer pi openai-codex/gpt-5.6-sol
/orch-model reset worker
```

For worker routes, `opencode` runs the OpenCode CLI and `pi` bypasses OpenCode completely, using Pi's authenticated providers directly. Selections are saved to the per-user `pi-orch/models.json` config and are applied to the running Pi session without an orchestrator restart. The same settings can also be changed from outside Pi with the `pi-orch model` command (for example `pi-orch model parent openai-codex/gpt-5.6-sol` or `pi-orch model tester opencode-go/glm-5.2`), and those changes likewise apply to an already running Pi session without restarting the orchestrator.

The `tester` profile model is configured through the same surfaces: `pi-orch model tester [pi|opencode] <provider/model>`, the `PI_OPENCODE_PROFILE_TESTER` environment variable, or the saved per-user config. `/opencode-status` shows the active tester profile. `tester` and `reviewer` require `read_only` mode and are never inferred from the task name.

After updating the extension code itself (for example `git pull` plus `npm install`), restart or reload Pi once so the running session uses the new extension code. Once that reload has happened, subsequent model changes through `/orch-model` or `pi-orch model` remain live without another restart.

How changes apply to a running session:

- `parent` switches immediately after validation; the next parent request uses the new model.
- `worker`, `implementer`, `reviewer`, and `tester` changes affect newly started workers only; workers already running keep the model they were started with and stay unchanged.
- `reset` (for example `/orch-model reset worker` or `pi-orch model reset worker`) or deleting the saved setting returns that target to its startup baseline: the launcher's environment-variable override (`PI_CODEX_MODEL`, `PI_OPENCODE_MODEL`, `PI_OPENCODE_PROFILE_IMPLEMENTER`, `PI_OPENCODE_PROFILE_REVIEWER`, `PI_OPENCODE_PROFILE_TESTER`) if set, otherwise the built-in default.
- Environment-variable overrides continue to take effect from the next orchestrator launch on; a change made in the running session takes precedence until then.

## Herdr status integration (optional)

When launched inside a Herdr pane, the extension reports orchestrator status through Herdr's official CLI. It is disabled unless all three values are present in the process environment:

```bash
HERDR_ENV=1
HERDR_PANE_ID=<pane-id>
HERDR_BIN_PATH=<path-to-herdr>
```

Reports use `pane report-agent` with `--source custom:pi-orch` and `--agent pi-orch`; shutdown uses `pane release-agent`. The mapping is `working` when workers/workflows are running, `blocked` when retained or cleanup-failed worktrees await a decision, and `idle` otherwise. Only coarse state transitions are sent, with a monotonically increasing sequence number. Messages contain counts only; prompts, secrets, repository paths, and worktree paths are not sent.

Herdr reporting is fail-open: a missing or failing CLI never affects orchestration, and bounded path-free diagnostics are available in `/opencode-status`. No Herdr installation or configuration is required outside a Herdr-managed pane.

## Fast, transparent orchestration UX

Routine parent and worker thinking default to `high` for quality-first results; `low` remains available explicitly for faster responses, and the `reviewer` role always resolves to `high`. Blocking tools (`opencode_task`, `opencode_wait`, `opencode_workflow` foreground, `opencode_workflow_wait`, `opencode_verified_task` foreground) stream concise live progress about once per second via `onUpdate` (one line per worker: id, status, elapsed time, latest safe activity; bounded to 6 lines / 800 chars) while keeping the existing all-settled background batching for final delivery. Worker activity labels are safe, bounded action summaries (`tool: status [file-ish target]`, max 120 chars): raw reasoning text, full shell commands, secrets, and absolute managed-worktree paths are never exposed (absolute paths collapse to `<path>/basename`, secrets to `[redacted]`). The worker timeout is unchanged (a failure guard, not a speed control), and the dashboard stays within its 10-line bound.

## Live activity dashboard

While worker tasks are running, Pi shows a widget above the editor. It refreshes about once per second and includes:

- running worker and workflow counts
- each worker ID, backend, full model ID, elapsed time, mode, task name, and latest activity
- each workflow ID, elapsed time, and current phase

The widget disappears automatically when no OpenCode work remains. The compact footer status and `/opencode-status` command remain available.

## Coordinator-only parent enforcement

The parent agent runs in a coordinator-only mode that is enabled by default with no opt-out. The parent's active tools are limited to safe planning reads (`read`, `grep`, `find`, `ls`) plus the `opencode_*` orchestration tools. All other or unknown tool calls — including `bash`, `edit`, `write`, `apply_patch`, and `patch` — are blocked at execution even if another preset reactivates them. A direct user `!` or `!!` bash command from the parent is cancelled.

Every agent turn receives coordinator-contract guidance in its system prompt. Implementation and command-based testing/verification must be delegated to the `implementer`, `tester`, or `reviewer` roles. Trivial read-only inspection remains allowed when needed for planning or a final judgment.

Slash commands such as `/orch-model`, `/opencode-status`, `/opencode-usage`, and the live dashboard remain available to the parent. Child workers are separate processes and are unaffected by this parent-only restriction.

Activating this behavior requires the new extension code: after updating the extension, reload or restart Pi once. This is a coordinator-contract guard, not a security sandbox; it does not claim to sandbox the parent, and later extensions can still alter the system prompt.

## Document coordinator skill

A project-trusted Pi skill is available for documentation work. Pi auto-discovers it from `.pi/skills/orchestrator-role-coordinator/SKILL.md`; no `package.json` registration is needed for project discovery. Invoke it explicitly with `/skill:orchestrator-role-coordinator` when planning multi-worker roles, worktree batches/recovery, or model routing.

The skill uses progressive disclosure and adds no scripts, dependencies, or network access. It grants no tools and never overrides the coordinator-only, tool, or worktree runtime gates. Because discovery happens at session start, an already-running Pi process must be reloaded or restarted once before the newly added skill is found.

## Worker backends and models

Each worker route can use either the OpenCode backend or the Pi backend. The Pi backend launches a bounded, non-interactive Pi worker with the selected Pi provider/model and never starts OpenCode. Read-only Pi workers receive only read/search tools; write workers receive the editing toolset.

### Opt-in Executor MCP gateway

Set `PI_ORCH_ENABLE_EXECUTOR=1` and set `executor: true` on a task to add a local `mcp.executor` server to the generated OpenCode config. It is accepted only for the OpenCode backend with an explicit `role: "implementer"`; disabled, Pi/Collie, reviewer/tester, and no-role requests fail before spawning. The command is fixed to `[PI_EXECUTOR_BIN || "executor", "mcp", "--elicitation-mode", "browser", "--no-artifacts", "--search-tools"]`. The generated config is fail-closed: ambient `OPENCODE_CONFIG_CONTENT` is discarded and only the manager-generated `mcp.executor` entry is present when opted in. Each worker also gets private `OPENCODE_CONFIG_DIR`/`XDG_CONFIG_HOME` directories, `OPENCODE_DISABLE_PROJECT_CONFIG=1`, and `--pure`; `HOME`/data locations remain available for saved CLI authentication. Executor failures are terminal; there is no fallback backend. Keep authentication and other secrets out of task prompts and reports. Provider environment keys should normally not be needed because workers use saved CLI authentication; if one is required, add its name explicitly to `PI_ORCH_WORKER_ENV_ALLOWLIST` (values and variable names are never included in worker reports).

### Experimental Collie backend

Collie is an opt-in isolated route selected with `model: "collie::provider/model"`. It launches only when `PI_ORCH_ENABLE_COLLIE=1` and the task is exactly `mode: "write"`, `role: "implementer"`, and `worktree: true`; every other Collie request is rejected before the child process or worktree starts. The executable is `PI_COLLIE_BIN` or `collie` by default. The adapter invokes `collie run <structured prompt> --provider <provider> --model <model> --cwd <managed worktree> --mode auto --json --stream-json`. Collie has no claimed tool allowlist: isolation and the existing worktree scope/integration gates remain the security boundary, and worktree isolation is not an OS sandbox. Final stdout JSON (`answer`/`error`/`usage`) is normalized to the common report/usage fields; NDJSON stderr is retained as raw diagnostics and summarized as activity.

The default routes remain `opencode-go/glm-5.2` and `opencode-go/kimi-k3`. The `implementer`, `tester`, and `reviewer` profile names are role-based aliases and do not force any specific model family. The `tester` profile defaults to the default worker model (`opencode-go/glm-5.2`) and is configurable through `PI_OPENCODE_PROFILE_TESTER` or `pi-orch model tester [pi|opencode] <provider/model>`.

Override any profile when needed:

```bash
PI_OPENCODE_PROFILE_IMPLEMENTER=opencode-go/glm-5.2 \
PI_OPENCODE_PROFILE_REVIEWER=opencode-go/kimi-k3 \
PI_OPENCODE_PROFILE_TESTER=opencode-go/glm-5.2 \
pi-orch
```

Final approval remains with GPT-5.6 Sol through the parent or a separate Codex CLI review:

```bash
codex exec -m gpt-5.6-sol --sandbox read-only "$(cat /tmp/codex_prompt.md)"
```

The reviewer profile provides a different review perspective but does not grant final approval.

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

When a profile's tool count exceeds a valid `maxTools` (a finite positive integer), the manager trims to the limit and records a `capability:` notice in worker activity. Invalid values such as zero, negative, fractional, `NaN`, or `Infinity` are ignored. The trimmed tools remain denied by the generated agent's wildcard permission, so the activity display and the worker's effective permissions match. `toolSchema` is capability metadata only: it is parsed and kept for diagnostics, but no schema shaping is applied to worker requests.

### How it reaches OpenCode

OpenCode resolves agents by **name** from the private per-spawn `OPENCODE_CONFIG_DIR/agent/<name>.md`. Per spawn, the manager writes a frontmatter-only agent definition with a first/default `"*": deny` permission followed by explicit `allow` entries for only the effective tool set (the profile after any `maxTools` reduction), passes `--agent <name>`, and recursively removes the private runtime directory on close/timeout. The Executor task additionally allows only the `mcp.executor.*` pattern. The parent decides the tool set; ambient global/project/`.opencode` config no longer affects worker tool availability.


## Using it in another repository

Copy the extension directory into that repository:

```bash
mkdir -p /path/to/project/.pi/extensions
cp -R .pi/extensions/opencode-orchestrator /path/to/project/.pi/extensions/
```

You may also copy `scripts/pi_codex_orchestrator.sh` or launch Pi with the same tool allowlist shown in that script.

## Task model

Each worker receives a structured objective, mode, relevant paths, constraints, and expected output.

Tasks may select the `implementer`, `tester`, or `reviewer` role. A role is never inferred from the task name. Direct `model` overrides remain available for any OpenCode provider/model ID. `tester` and `reviewer` roles require `read_only` mode.

Explicit roles:

- `implementer`: a write-capable role alias. It honors the declared-path write rules below; beyond the task's mode there are no additional tool restrictions.
- `tester`: independent read-only verification. Bash is enabled for running tests and verification commands, but the edit/write toolset is denied. A tester spawn requires a Git worktree: a content-based Git fingerprint (tracked worktree diff, staged diff, and nonignored untracked files) is captured before the run and compared afterwards. Any tracked, staged, or nonignored untracked mutation marks the task as an error without auto-reverting. This is post-run detection, not a sandbox: bash can mutate during execution, and outside-repo or ignored side effects are not prevented.
- `reviewer`: strictly read-only review with no bash and no edit tools. It always resolves to `high` thinking for a stronger independent perspective.

- `read_only`: file changes are forbidden; overlapping research scopes are allowed.
- `write`: changes are limited to declared paths. Concurrent tasks are rejected when scopes are identical or have a parent/child relationship. Non-worktree write workers are checked after completion by comparing Git content fingerprints from before and after the run; only paths changed during that run are scope-checked, so pre-existing dirty changes are preserved.
- `opencode_workflow`: requires at least two sequential phases. Tasks inside one phase fan out under the same global four-worker cap.
- `opencode_verified_task`: one-objective standard verification loop (see below) inside the `workflows` tool group.

Path enforcement is a scheduler, prompt-level, and (for direct writes) post-run guard, not an operating-system sandbox. The post-run guard reports out-of-scope changes as errors and never reverts files; bash can still mutate during execution or outside the repository, and ignored side effects are not prevented. The parent Codex agent must still inspect the final diff and run relevant tests.

## Opt-in worktree write isolation

For genuinely parallel writes that touch disjoint paths, opt each write task into isolated worktree execution with `worktree: true` (valid only for `mode: write`). The worker runs in a detached Git worktree under the OS temp directory, so parallel workers never touch the live working tree. When a worktree task finishes cleanly, its changes are extracted as a Git binary patch and applied to the repository root.

### Single direct write vs. parallel isolated writes

- A single direct (non-worktree) write on a dirty tree is still supported. Direct writes are never routed through the worktree integration queue.
- Concurrent writes are rejected unless every currently running write task — and the new one — opts into worktree isolation (`worktree: true`) **and** their concrete relevant paths are disjoint (no file or containing-directory overlap).
- Trying to run writes concurrently without isolating them makes the extension reject the spawn with guidance to opt into `worktree=true`.

### Batch setup and integration

- The first worktree task in a batch requires a clean Git root (no tracked, staged, or nonignored-untracked changes); a dirty root is refused. Later worktree tasks in the same batch share that base and must be spawned while the batch is still open — that is, before the batch settles.
- Integration applies each worker's Git binary patch to the repository root in task-ID order, without committing, stashing, or resetting. The batch retains its starting HEAD and the buffers of successful integrations. Before each apply, a temporary detached shadow worktree replays those buffers plus the current patch from the batch base HEAD to calculate the exact expected fingerprint (including HEAD OID); the root must match its prior fingerprint before `git apply --check`, between check/apply, and must exactly match the shadow postcondition afterward. Any HEAD change, extra/same-path mutation, mismatch, or shadow cleanup failure poisons the batch and aborts without automatic revert.
- Because integration mutates the root, the root becomes dirty after a worktree batch settles. Commit or clean it before starting another worktree batch.

### JSON examples

A single isolated write spawn:

```json
opencode_spawn({
  "name": "isolated-edit",
  "mode": "write",
  "worktree": true,
  "objective": "Implement the requested change only inside src/a.ts.",
  "relevant_paths": ["src/a.ts"],
  "expected_output": "Report the changed file and a short summary."
})
```

A workflow with a read-only phase, one worktree-write phase, then a read-only verification phase:

```json
opencode_workflow({
  "name": "isolated-workflow",
  "phases": [
    {
      "name": "research",
      "tasks": [
        {
          "name": "inspect",
          "mode": "read_only",
          "objective": "Inspect the relevant modules and summarize constraints.",
          "relevant_paths": ["src/"],
          "expected_output": "A concise plan."
        }
      ]
    },
    {
      "name": "edit",
      "tasks": [
        {
          "name": "edit-a",
          "mode": "write",
          "worktree": true,
          "objective": "Apply change A.",
          "relevant_paths": ["src/a.ts"],
          "expected_output": "Report changed file A."
        },
        {
          "name": "edit-b",
          "mode": "write",
          "worktree": true,
          "objective": "Apply change B.",
          "relevant_paths": ["src/b.ts"],
          "expected_output": "Report changed file B."
        }
      ]
    },
    {
      "name": "verify",
      "tasks": [
        {
          "name": "test",
          "mode": "read_only",
          "role": "tester",
          "objective": "Run the tests after integration.",
          "relevant_paths": ["src/"],
          "expected_output": "Test results."
        }
      ]
    }
  ]
})
```

### Workflow phase restrictions

Worktree writes integrate through the root, so workflows constrain them tightly:

- At most one worktree-write phase per workflow.
- A worktree-write phase may contain only worktree writes (`mode: write` with `worktree: true`); no read-only, tester, reviewer, or direct-write task may be mixed into it.
- Only read-only phases may precede the worktree-write phase.
- Read/test/review and direct-write phases may follow it; the worktree phase must fully settle and integrate before a later phase starts.

### Standard verification loop (opencode_verified_task)

`opencode_verified_task` runs one objective through a fixed three-phase workflow generated from a single input (`name`, `objective`, `relevant_paths`, optional `constraints`, `expected_output`, optional `worktree`, and optional `implementer_model`/`tester_model`/`reviewer_model` overrides):

1. `implement` — one write task with the `implementer` role (the only phase allowed to edit; `worktree: true` applies here and satisfies the worktree-write phase restrictions because the later phases are read-only).
2. `test` — one read-only task with the `tester` role that runs the relevant tests/verification commands.
3. `review` — one read-only task with the `reviewer` role that independently reviews the change.

The `test` and `review` phases carry the internal `requireResolved` quality gate: even when a gate worker settles with `status=done`, a non-empty `report.unresolved` array fails the workflow (`status=error`), and the next phase never starts. A tester/reviewer worker that ends in `status=error` (for example a failing test run) stops the workflow through the existing phase-failure path. There is no automatic retry and no loop: re-run the tool with a refined objective if the gate blocked progression.

Final approval always stays with the parent. A completed verified workflow is verification evidence only — the parent must still inspect the diff and decide. No delegated worker ever grants final approval.

```json
opencode_verified_task({
  "name": "verified-edit",
  "objective": "Implement the requested change only inside src/a.ts.",
  "relevant_paths": ["src/a.ts", "tests/a.test.ts"],
  "expected_output": "Report the changed file and a short summary.",
  "worktree": true
})
```

### Failure and retention

- A worktree task that fails, is cancelled, times out, moves its own HEAD (commits inside the worktree), changes out-of-scope paths, contains submodule/gitlink changes, or whose patch is rejected is never integrated and never auto-reverted. Its worktree and patch are retained, with the error, in a current-session-only registry for manual cleanup.
- After successful integration, the worktree and its temporary patch file are removed. On Windows, removing a worktree can leave an empty `oc-worktrees` temp directory behind — harmless.

### Worktree cleanup and conflict UI

Manage retained or conflicted worktrees in the running session with `/opencode-worktrees`:

```text
/opencode-worktrees list
/opencode-worktrees status <worktree-id>
/opencode-worktrees inspect <worktree-id>
/opencode-worktrees retry <worktree-id>
/opencode-worktrees discard <worktree-id>
```

- `list` shows retained worktrees and their state. `status` reports a single worktree's detail; `inspect` surfaces its error and conflict context. `retry` re-attempts integration; `discard` removes the retained worktree and patch.
- Confirmation requirements: destructive operations are confirmed through the TUI; RPC/REST callers must pass an explicit confirmation flag. `discard` and `retry` are destructive and refuse to run without explicit confirmation.
- Retry safety:
  - The retried patch is the validated patch captured from the original current-session run; a replacement patch is never accepted.
  - A retry is rejected while any task or batch for the same repository is active.
  - Retry is permitted only when the root is clean and its HEAD OID still equals the retained original base HEAD. A detached shadow replays the validated buffer to establish the exact expected postcondition; the root is checked before and after `git apply --check`, and after `git apply`.
  - Integration never uses reset, stash, commit, or a 3-way merge; any postcondition failure leaves the root untouched when possible and never automatically reverts it.
  - The extension does not attempt automatic conflict resolution. Conflicted integrations are surfaced for manual resolution or discard.
- Behavior on failed cleanup or successful root integration: when a worktree cannot be cleaned up (`cleanup-failed`) it stays registered for a later attempt; when the patch is applied to the root (`rootIntegrated`) the retained worktree is removed and the root is left dirty for you to commit or clean.
- Read-only inspection is available to agents through the `inspection` tool group as `opencode_worktree_list` and `opencode_worktree_status`; these return no filesystem paths in model-facing output.
- The dashboard may retain a "worktree cleanup needed" warning while retained worktrees exist. There is no automatic cleanup on orchestrator shutdown.
- The registry is current-session-only. Restart/crash recovery and cross-session garbage collection are deferred; on a restart, temp artifacts may remain for the OS to clean up and are not listed, and no path is exposed in model-facing output.
- Worktree isolation isolates the working tree; it is not a sandbox. It does not prevent a worker's bash from running arbitrary commands or writing outside the worktree during execution. Only the final staged patch within declared scopes is integrated.

### Roles and extension reload

- `tester` and `reviewer` roles are unchanged and remain read-only; they are not affected by worktree write isolation.
- This feature requires the new extension code. After updating the extension (for example `git pull` plus `npm install`), reload Pi once so the running session uses the new code.

## Routing and token-aware delivery

### When to delegate vs. stay on the parent

- Trivial one-read or tiny one-file work stays on the parent. Do not spawn a worker for it.
- State a brief visible plan (1-3 lines) before spawning workers so progress stays transparent.
- Prefer background `opencode_spawn` and continue useful orchestration work; call `opencode_wait` only when results are actually needed instead of blocking immediately after spawn.
- Bounded, mechanical work (scoped implementation, test additions, docs updates) delegates to a worker.
- Broad independent research parallelizes across multiple `opencode_spawn` workers (up to four).
- Ambiguous, risky, or final-review work stays on the parent. High thinking is the quality-first default; use `PI_CODEX_THINKING=low` or a per-task `thinking: low` explicitly when speed matters.

### Compact results and raw output

Each worker returns a structured report with `summary`, `files`, `findings`, and `unresolved` fields, targeting roughly 2–4k characters. The extension retains up to 120k characters of raw worker output, but normal delivery to the parent is capped at 8k characters, and workflow phase handoffs pass a compact JSON blob capped at 4k characters. When the compact preview is insufficient, call `opencode_output` with an offset/limit to fetch a retained raw slice on demand.

### Batched background delivery

Background completions are not delivered one-by-one. When the parent is idle and no background tasks or workflows remain running, settled workers and workflows are batched into a single follow-up message (capped at 8k). This avoids many small follow-ups interrupting the parent.

### One-turn result retention and context pruning

To stop the parent model from repeatedly re-reading large orchestration results, the extension hooks Pi's `context` event and replaces the model-facing content of **old** orchestration results with a short deterministic placeholder. Targets are `opencode_*` tool results and `opencode-batch-result` custom messages. A result is pruned only once it appears before the latest real user-role message, so the current turn's freshly returned worker result or background batch remains fully available for the immediate next model call and is pruned starting with the next user turn. Message ordering, roles, tool call IDs, tool names, and non-target messages are preserved; useful task/workflow IDs are kept in the placeholder when available from the result details.

Pruning is non-destructive: the session JSONL and the manager's retained raw output are never changed, and `opencode_output` can still fetch any retained slice on demand. `/opencode-usage` reports the latest outbound request's pruned-message count and characters removed, avoiding repeated counting of the same historical messages.

### Dynamic tool groups

The core orchestration tools `opencode_task`, `opencode_spawn`, `opencode_wait`, and `opencode_tools` (plus unrelated tools owned by Pi and other extensions) are always active. Optional tools — `opencode_check`, `opencode_cancel`, `opencode_list`, `opencode_output`, the `opencode_workflow*` family, and `opencode_verified_task` — start inactive to keep the system prompt lean and prompt caching stable, and are loaded on demand:

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
