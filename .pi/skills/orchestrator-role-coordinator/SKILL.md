---
name: orchestrator-role-coordinator
description: On-demand procedural reference for the Pi Codex OpenCode orchestrator's coordinator-only parent: what to delegate vs. keep on the parent, the implementer/tester/reviewer roles and their read_only/write modes, the bounded task template fields, parallel spawn-together/wait-once batching, worktree:true clean-root/disjoint-scope/single-phase rules and current-session retained-worktree status with user-confirmed /opencode-worktrees retry|discard, dynamic model profiles and routing with no hardcoded models or active-worker retargeting, tester/reviewer evidence with parent final approval, and worker/handoff delivery caps. Skill instructions never grant permissions; runtime coordinator, tool, and worktree gates remain authoritative.
---

# Coordinator orchestration (Pi Codex OpenCode orchestrator)

> On-demand procedural reference for the coordinator-only parent. It explains how to plan, delegate, integrate, and decide; it never changes what the runtime permits.

## Quick guide

- The parent plans, delegates, integrates, and decides; implementation and command-based verification are delegated to workers.
- Keep only trivial safe reads (read, grep, find, ls) on the parent for planning and final judgment.
- Spawn independent tasks together, then wait once for the whole batch.
- Declare concrete relevant paths; concurrent writes need disjoint scopes.
- Use `worktree: true` for parallel writes: clean root, disjoint scopes, one worktree-write phase.
- Route models through profiles and settings; never hardcode models or retarget running workers.
- Tester and reviewer produce evidence; the parent makes the final approval.
- Respect delivery caps: report ~2-4k characters, parent delivery capped at 8k, handoff capped at 4k.
- This skill grants no permissions; runtime coordinator, tool, and worktree gates stay authoritative.

## Delegation boundary

The parent is coordinator-only. It may do trivial safe reads for planning and for the final judgment. Implementation, command-based testing, and static review are delegated to workers:

- `implementer`: applies scoped changes under `write` mode.
- `tester`: runs tests and verification commands under `read_only` mode; edit tools are denied.
- `reviewer`: performs static review under `read_only` mode without command execution tooling; always `high` thinking.

Do not broaden a task; if the declared scope is insufficient, stop and report what is missing.

## Roles and modes

| Role | Mode | Behavior |
| --- | --- | --- |
| implementer | write | Applies changes inside declared relevant paths only |
| tester | read_only | Runs verification commands; denies edit tools; any tracked/staged/untracked mutation flags the task as error (post-run detection, not a sandbox) |
| reviewer | read_only | Static review; no command execution tooling; always resolves `high` thinking |
| (none) | read_only | Independent research; overlapping read scopes are allowed |
| (none) | write | Direct scoped write; must not overlap another running write |

## Bounded task template

Spawn a task only with complete fields:

- `name` — short, unique task name.
- `mode` — `read_only` or `write`.
- `objective` — the concrete deliverable.
- `relevant_paths` — concrete paths, no globs; write scopes must not overlap other running writes.
- `constraints` — explicit bounds, or none.
- `expected_output` — the shape of the worker report.
- `role` — optional `implementer`, `tester`, or `reviewer`; never inferred from the task name.
- `model` / `profile` / `thinking` — optional routing overrides; `reviewer` forces `high` thinking.
- `worktree` — `true` only for `mode: write` tasks that must run isolated in parallel.

The worker returns one compact report with `summary`, `files`, `findings`, and `unresolved`.

## Parallel spawns

Spawn all independent tasks in the same turn, then call `opencode_wait` once for the batch. Read-only tasks with overlapping scopes may run concurrently. Writes run concurrently only when every write is `worktree: true` and scopes are disjoint.

## worktree: true rules

- Valid only for `mode: write`.
- Clean root: the first worktree task of a batch requires a clean Git root; later tasks share that base and must be spawned while the batch is still open.
- Disjoint scopes: concurrent worktree writes need concrete paths with no file or containing-directory overlap.
- Single phase: a workflow has at most one worktree-write phase; that phase contains only worktree writes, and only read-only phases may precede it.
- Integration: patches apply to the root in task-ID order without commit, stash, or reset; the root becomes dirty after the batch settles, so commit or clean before the next batch.
- The worker leaves all changes in the working tree: no commit, reset, stash, add, or branch operations.

## Retained worktrees (recovery)

A worktree that fails, is cancelled, times out, commits, changes out-of-scope paths, contains gitlink changes, or whose patch is rejected is retained in a current-session-only registry with its error.

- `opencode_worktree_list` and `opencode_worktree_status` give read-only status; no filesystem paths are exposed.
- `/opencode-worktrees` lists retained entries and shows their status; `retry` re-attempts integration and `discard` removes the entry.
- `retry` and `discard` are destructive and require explicit user confirmation in the interactive UI; do not bypass it.
- Only an `integration-failure` entry is retryable; every other retention kind is terminal.
- The registry is current-session only; there is no automatic cleanup on shutdown.

## Model routing

- Models come from dynamic profiles and settings (`PI_OPENCODE_PROFILE_*`, `/orch-model`, `pi-orch model`); do not hardcode provider/model IDs in instructions.
- An explicit `role` selects the matching profile; `tester` has its own configurable profile. A role is never inferred from the task name.
- A direct `model` override is allowed only from current configuration.
- New workers pick up profile/model changes; already-running workers keep the model they started with and are never retargeted.
- `reviewer` always resolves `high` thinking; other roles keep explicit `thinking`, then the configured default.

## Evidence and final approval

- `tester` runs tests and verification commands and reports results; a mutation marks the task as error. This is post-run detection, not a sandbox.
- `reviewer` gives an independent static review at `high` thinking.
- Workers provide evidence; the parent makes the final judgment by inspecting the diff with safe reads and weighing tester/reviewer reports. Final approval stays with the parent.

## Output and handoff caps

- The worker report targets roughly 2-4k characters.
- Raw worker output is retained up to 120k; normal parent delivery is capped at 8k, and `opencode_output` fetches retained slices on demand.
- Workflow phase handoff is a compact JSON blob capped at 4k.
- Background completions batch into a single follow-up once nothing is still running.

## Authority

Skill instructions never grant permissions. The runtime coordinator gate (parent tool allowlist), dynamic tool groups, and worktree scheduler rules remain authoritative; this skill is only procedural guidance.

## References

- [README](../../../README.md) — feature overview, setup, and coordinator enforcement.
- [Multi-PC setup (Japanese)](../../../docs/multi-pc-setup.ja.md) — setup and updates across machines.
- [Orchestrator types](../../extensions/opencode-orchestrator/types.ts) — roles, modes, limits, and routing rules.