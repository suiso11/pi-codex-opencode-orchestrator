import * as path from "node:path";

export const DEFAULT_MODEL = "opencode-go/glm-5.2";
export const MAX_RUNNING = 4;
export const MAX_TRACKED = 64;
export const MAX_OUTPUT_CHARS = 120_000;
export const MAX_ACTIVITY_ITEMS = 30;

export type TaskMode = "read_only" | "write";
export type TaskStatus = "running" | "done" | "error" | "cancelled";
export type WorkflowStatus = "running" | "done" | "error" | "cancelled";

export interface TaskSpec {
	name: string;
	mode: TaskMode;
	objective: string;
	relevantPaths: string[];
	constraints: string[];
	expectedOutput: string;
	model?: string;
}

export interface InternalTaskSpec extends TaskSpec {
	workflowId?: string;
}

export interface TaskSnapshot {
	id: string;
	name: string;
	mode: TaskMode;
	status: TaskStatus;
	objective: string;
	relevantPaths: string[];
	scopes: string[];
	model: string;
	workflowId?: string;
	createdAt: number;
	settledAt?: number;
	exitCode?: number;
	output: string;
	stderr: string;
	activity: string[];
	error?: string;
	timedOut: boolean;
	truncated: boolean;
}

export interface WorkflowPhaseSpec {
	name: string;
	tasks: TaskSpec[];
}

export interface WorkflowSnapshot {
	id: string;
	name: string;
	status: WorkflowStatus;
	phases: WorkflowPhaseSpec[];
	currentPhase?: number;
	taskIds: string[];
	createdAt: number;
	settledAt?: number;
	error?: string;
}

export function boundedAppend(current: string, chunk: string, max = MAX_OUTPUT_CHARS) {
	const next = current + chunk;
	if (next.length <= max) return { text: next, truncated: false };
	return { text: next.slice(next.length - max), truncated: true };
}

export function normalizeScopes(cwd: string, relevantPaths: string[]) {
	const root = path.resolve(cwd);
	const unique = new Set<string>();
	for (const requested of relevantPaths) {
		const value = requested.trim();
		if (!value) throw new Error("relevant_paths must not contain empty paths.");
		if (/[*?\[\]{}]/.test(value)) {
			throw new Error(`Path scopes must be concrete, not globs: ${requested}`);
		}
		const resolved = path.resolve(root, value);
		const relative = path.relative(root, resolved);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new Error(`Path scope escapes the working directory: ${requested}`);
		}
		unique.add(resolved);
	}
	if (unique.size === 0) throw new Error("Provide at least one relevant path.");
	return [...unique].sort();
}

export function scopeOverlaps(left: string, right: string) {
	const a = path.resolve(left);
	const b = path.resolve(right);
	return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

export function findScopeConflict(left: string[], right: string[]) {
	for (const a of left) {
		for (const b of right) {
			if (scopeOverlaps(a, b)) return { left: a, right: b };
		}
	}
	return undefined;
}

export function buildWorkerPrompt(spec: TaskSpec) {
	const modeInstruction = spec.mode === "read_only"
		? "This is read-only work. Do not modify, create, rename, or delete any file."
		: "You may edit files, but only within the declared relevant paths. Preserve unrelated user changes.";
	const constraints = spec.constraints.length > 0
		? spec.constraints.map((item) => `- ${item}`).join("\n")
		: "- No additional task-specific constraints.";

	return [
		"You are an OpenCode worker delegated by a Codex orchestrator running in Pi.",
		"Follow the repository's AGENTS.md.",
		"Do not read secrets or git-ignored runtime configuration such as config/*.env.",
		modeInstruction,
		"Do not broaden the task. If the declared scope is insufficient, stop and report what is missing.",
		"",
		`Task name: ${spec.name}`,
		`Mode: ${spec.mode}`,
		`Objective: ${spec.objective}`,
		"Relevant paths:",
		...spec.relevantPaths.map((item) => `- ${item}`),
		"Constraints:",
		constraints,
		`Expected output: ${spec.expectedOutput}`,
		"",
		"Return only: (1) key result, (2) changed files if any, (3) verification and outcome.",
		"Do not include long reasoning traces or full file contents.",
	].join("\n");
}

export function taskSummary(task: TaskSnapshot) {
	const elapsed = Math.max(0, (task.settledAt ?? Date.now()) - task.createdAt);
	return `${task.id} [${task.status}] ${task.mode} "${task.name}" (${Math.round(elapsed / 1000)}s, ${task.model})`;
}

function clippedTail(value: string, maxChars: number) {
	if (value.length <= maxChars) return value;
	return `[...${value.length - maxChars} earlier characters omitted...]\n${value.slice(-maxChars)}`;
}

export function taskResultText(task: TaskSnapshot, maxChars = 48_000) {
	const sections = [taskSummary(task)];
	if (task.error) sections.push(`Error: ${task.error}`);
	if (task.truncated) sections.push("[Output truncated; most recent content shown.]");
	const outputBudget = Math.max(1_000, Math.floor(maxChars * 0.8));
	const stderrBudget = Math.max(500, Math.floor(maxChars * 0.15));
	if (task.output.trim()) sections.push(clippedTail(task.output.trim(), outputBudget));
	if (task.stderr.trim()) sections.push(`stderr:\n${clippedTail(task.stderr.trim(), stderrBudget)}`);
	return clippedTail(sections.join("\n\n"), maxChars);
}

export function taskResultsText(tasks: TaskSnapshot[], maxChars = 80_000) {
	if (tasks.length === 0) return "No task results.";
	const perTask = Math.max(2_000, Math.floor(maxChars / tasks.length) - 32);
	const combined = tasks.map((task) => taskResultText(task, perTask)).join("\n\n---\n\n");
	if (combined.length <= maxChars) return combined;
	return `${combined.slice(0, maxChars)}\n\n[Combined task results truncated.]`;
}

export function validateWorkflowPhases(cwd: string, phases: WorkflowPhaseSpec[]) {
	if (phases.length < 2) throw new Error("A workflow requires at least two phases.");
	for (const [phaseIndex, phase] of phases.entries()) {
		if (!phase.name.trim()) throw new Error(`Phase ${phaseIndex + 1} needs a name.`);
		if (phase.tasks.length === 0) throw new Error(`Phase "${phase.name}" has no tasks.`);
		const writes = phase.tasks
			.filter((task) => task.mode === "write")
			.map((task) => ({ task, scopes: normalizeScopes(cwd, task.relevantPaths) }));
		for (let i = 0; i < writes.length; i++) {
			for (let j = i + 1; j < writes.length; j++) {
				const conflict = findScopeConflict(writes[i].scopes, writes[j].scopes);
				if (conflict) {
					throw new Error(
						`Write tasks "${writes[i].task.name}" and "${writes[j].task.name}" overlap in phase "${phase.name}".`,
					);
				}
			}
		}
	}
}
