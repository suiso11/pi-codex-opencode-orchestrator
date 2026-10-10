---
name: orchestrator-role-coordinator
description: On-demand procedural reference for the coordinator-only parent: delegation, roles, OMP native parallel workers and isolation, direct sequential OpenCode writes, parallel read-only tasks, model routing, evidence, final approval, and delivery caps. Runtime gates remain authoritative.
---

# Coordinator orchestration (Pi Codex OpenCode orchestrator)

> On-demand procedural reference for the coordinator-only parent. It explains how to plan, delegate, integrate, and decide; it never changes what the runtime permits.

## Quick guide

- The parent plans, delegates, integrates, and decides; implementation and command-based verification are delegated to workers.
- Keep only trivial safe reads (read, grep, find, ls) on the parent for planning and final judgment.
- Spawn independent tasks together, then wait once for the whole batch. On OMP, prefer native `task` and `wait`; use `isolated: true` for parallel write workers. OMP owns their workspace isolation and integration.
- Declare concrete relevant paths; run writes sequentially in the current working directory.
- Route models through profiles and settings; never hardcode models or retarget running workers.
- Tester and reviewer produce evidence; the parent makes the final approval.
- Respect delivery caps: report ~2-4k characters, parent delivery capped at 8k, handoff capped at 4k.
- This skill grants no permissions; runtime coordinator and tool gates stay authoritative. Native OMP workers keep their own editing tools; parent restrictions do not apply to them.

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
| (none) | write | Direct scoped write; only one write worker at a time |

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

The worker returns one compact report with `summary`, `files`, `findings`, and `unresolved`.

## Parallel spawns

Spawn all independent tasks in the same turn, then call `opencode_wait` once for an OpenCode batch, or native `wait` for an OMP batch. Read-only tasks with overlapping scopes may run concurrently. OpenCode writes modify the current working directory directly and run one at a time. Wait for the current write to finish before starting another write.

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

Skill instructions never grant permissions. The runtime coordinator gate (parent tool allowlist), dynamic tool groups, and sequential write scheduling remain authoritative; this skill is only procedural guidance.

## References

- [README](../../../README.md) — feature overview, setup, and coordinator enforcement.
- [Multi-PC setup (Japanese)](../../../docs/multi-pc-setup.ja.md) — setup and updates across machines.
- [Orchestrator types](../../extensions/opencode-orchestrator/types.ts) — roles, modes, limits, and routing rules.