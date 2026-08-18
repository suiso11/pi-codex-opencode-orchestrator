import * as path from "node:path";

export const DEFAULT_MODEL = "opencode-go/glm-5.2";
export const MODEL_PROFILE_DEFAULTS = {
	glm: "opencode-go/glm-5.2",
	kimi_k3: "opencode-go/kimi-k3",
} as const;
export const MAX_RUNNING = 4;
export const MAX_TRACKED = 64;
export const MAX_OUTPUT_CHARS = 120_000;
export const MAX_ACTIVITY_ITEMS = 30;
export const MAX_PARENT_OUTPUT_CHARS = 8_000;

export type TaskMode = "read_only" | "write";
export type TaskStatus = "running" | "done" | "error" | "cancelled";
export type WorkflowStatus = "running" | "done" | "error" | "cancelled";
export type ModelProfile = keyof typeof MODEL_PROFILE_DEFAULTS;
export type WorkerBackend = "opencode" | "pi";
export type ThinkingLevel = "low" | "medium" | "high";

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

export interface TaskUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cost?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	reasoningTokens?: number;
}

export interface WorkerReport {
	summary: string;
	files: string[];
	findings: string[];
	unresolved: string[];
}

const PI_WORKER_PREFIX = "pi::";

export function encodeWorkerModel(backend: WorkerBackend, model: string) {
	const value = model.trim();
	if (!value) throw new Error("Worker model must not be empty.");
	return backend === "pi" ? `${PI_WORKER_PREFIX}${value}` : value;
}

export function decodeWorkerModel(value: string): { backend: WorkerBackend; model: string } {
	const normalized = value.trim();
	if (normalized.startsWith(PI_WORKER_PREFIX)) {
		return { backend: "pi", model: normalized.slice(PI_WORKER_PREFIX.length) };
	}
	return { backend: "opencode", model: normalized };
}

export interface TaskSpec {
	name: string;
	mode: TaskMode;
	objective: string;
	relevantPaths: string[];
	constraints: string[];
	expectedOutput: string;
	model?: string;
	profile?: ModelProfile;
	thinking?: ThinkingLevel;
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
	backend: WorkerBackend;
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
	usage?: TaskUsage;
	report?: WorkerReport;
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
	handoffCharsCreated?: number;
	handoffCharsInjected?: number;
}

export function configuredModelProfiles(env: NodeJS.ProcessEnv = process.env): Record<ModelProfile, string> {
	return {
		glm: env.PI_OPENCODE_PROFILE_GLM?.trim() || MODEL_PROFILE_DEFAULTS.glm,
		kimi_k3: env.PI_OPENCODE_PROFILE_KIMI_K3?.trim() || MODEL_PROFILE_DEFAULTS.kimi_k3,
	};
}

export function configuredThinkingLevel(env: NodeJS.ProcessEnv = process.env): ThinkingLevel {
	const raw = (env.PI_OPENCODE_THINKING ?? "").trim().toLowerCase();
	if (raw === "low" || raw === "medium" || raw === "high") return raw;
	return DEFAULT_THINKING_LEVEL;
}

export function resolveModel(
	spec: Pick<TaskSpec, "model" | "profile">,
	fallback: string,
	profiles: Readonly<Record<ModelProfile, string>> = configuredModelProfiles(),
) {
	const explicit = spec.model?.trim();
	if (explicit) return explicit;
	if (!spec.profile) return fallback;
	const resolved = profiles[spec.profile];
	if (!resolved) throw new Error(`Unknown OpenCode model profile: ${spec.profile}`);
	return resolved;
}

export function resolveThinkingLevel(
	spec: Pick<TaskSpec, "thinking">,
	fallback: ThinkingLevel,
): ThinkingLevel {
	return spec.thinking ?? fallback;
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

export function pathForScopeComparison(value: string, platform: NodeJS.Platform = process.platform) {
	const resolved = path.resolve(value);
	return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function scopeOverlaps(left: string, right: string) {
	const a = pathForScopeComparison(left);
	const b = pathForScopeComparison(right);
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
		"You are a bounded worker delegated by a parent orchestrator running in Pi.",
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
		"Return ONLY one compact JSON object with exactly these fields and nothing else:",
		"{",
		'  "summary": short string with the key result and verification outcome,',
		'  "files": string array of changed files (empty for read-only work),',
		'  "findings": string array of concise findings,',
		'  "unresolved": string array of unresolved issues or blockers',
		"}",
		"Target roughly 2-4k characters total. No reasoning trace, no prose, no full file contents.",
		"If the task cannot be completed, still emit the JSON with unresolved populated.",
	].join("\n");
}

export function taskSummary(task: TaskSnapshot) {
	const elapsed = Math.max(0, (task.settledAt ?? Date.now()) - task.createdAt);
	return `${task.id} [${task.status}] ${task.mode} "${task.name}" (${Math.round(elapsed / 1000)}s, ${task.backend}:${task.model})`;
}

function taskUsageText(usage: TaskUsage) {
	const parts = [
		`in ${(usage.inputTokens ?? 0).toLocaleString()}`,
		`out ${(usage.outputTokens ?? 0).toLocaleString()}`,
		`total ${(usage.totalTokens ?? 0).toLocaleString()}`,
	];
	if (usage.cacheReadTokens !== undefined) parts.push(`cache read ${usage.cacheReadTokens.toLocaleString()}`);
	if (usage.cacheWriteTokens !== undefined) parts.push(`cache write ${usage.cacheWriteTokens.toLocaleString()}`);
	if (usage.reasoningTokens !== undefined) parts.push(`reasoning ${usage.reasoningTokens.toLocaleString()}`);
	if (usage.cost !== undefined) parts.push(`cost ${usage.cost.toFixed(6)}`);
	return `Usage: ${parts.join(" · ")}`;
}

function clippedTail(value: string, maxChars: number) {
	if (value.length <= maxChars) return value;
	if (maxChars <= 0) return "";
	// For very small budgets, keep the most recent characters with no marker.
	if (maxChars < 24) return value.slice(-maxChars);
	// Reserve room for a truncation marker, then keep the most recent tail.
	const tailBudget = maxChars - 40;
	if (tailBudget <= 0) return value.slice(-maxChars);
	const tail = value.slice(-tailBudget);
	const marker = `[...${value.length - tail.length} earlier characters omitted...]\n`;
	const result = `${marker}${tail}`;
	return result.length <= maxChars ? result : result.slice(-maxChars);
}

export function taskResultText(task: TaskSnapshot, maxChars = MAX_PARENT_OUTPUT_CHARS) {
	if (maxChars <= 0) return "";
	const sections = [taskSummary(task)];
	if (task.error) sections.push(`Error: ${task.error}`);
	if (task.truncated) sections.push("[Output truncated; most recent content shown.]");
	if (task.usage) sections.push(taskUsageText(task.usage));

	const report = task.report;
	if (
		report &&
		(report.summary ||
			report.files.length > 0 ||
			report.findings.length > 0 ||
			report.unresolved.length > 0)
	) {
		if (report.summary) sections.push(`Summary: ${report.summary}`);
		if (report.files.length > 0) {
			sections.push(`Files:\n${report.files.map((f) => `- ${f}`).join("\n")}`);
		}
		if (report.findings.length > 0) {
			sections.push(`Findings:\n${report.findings.map((f) => `- ${f}`).join("\n")}`);
		}
		if (report.unresolved.length > 0) {
			sections.push(`Unresolved:\n${report.unresolved.map((f) => `- ${f}`).join("\n")}`);
		}
	} else if (task.output.trim()) {
		const outputBudget = Math.max(1_000, Math.floor(maxChars * 0.8));
		sections.push(clippedTail(task.output.trim(), outputBudget));
	}

	if (task.stderr.trim()) {
		const stderrBudget = Math.max(250, Math.floor(maxChars * 0.1));
		sections.push(`stderr:\n${clippedTail(task.stderr.trim(), stderrBudget)}`);
	}
	return clippedTail(sections.join("\n\n"), maxChars);
}

export function taskResultsText(tasks: TaskSnapshot[], maxChars = MAX_PARENT_OUTPUT_CHARS) {
	if (maxChars <= 0) return "";
	if (tasks.length === 0) {
		const empty = "No task results.";
		return empty.length <= maxChars ? empty : empty.slice(0, maxChars);
	}
	const perTask = Math.max(1_000, Math.floor(maxChars / tasks.length) - 32);
	const combined = tasks.map((task) => taskResultText(task, perTask)).join("\n\n---\n\n");
	if (combined.length <= maxChars) return combined;
	const marker = "\n\n[Combined task results truncated.]";
	const budget = maxChars - marker.length;
	if (budget <= 0) return combined.slice(-maxChars);
	return `${combined.slice(0, budget)}${marker}`;
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

const FALLBACK_REPORT_BUDGET = 1_500;
const REPORT_FIELD_BUDGETS = { summary: 1_000, item: 500, file: 256 } as const;

export function emptyReport(): WorkerReport {
	return { summary: "", files: [], findings: [], unresolved: [] };
}

function clampString(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	return value.length <= max ? value : value.slice(0, max);
}

function asStringArray(value: unknown, itemMax: number): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === "string") {
			const trimmed = item.trim();
			if (trimmed) out.push(trimmed.slice(0, itemMax));
			if (out.length >= 16) break;
		}
	}
	return out;
}

function tryParseJsonObject(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Not valid JSON — fall through to next strategy.
	}
	return undefined;
}

function extractFencedJsonBlocks(text: string): string[] {
	const blocks: string[] = [];
	const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
	let match: RegExpExecArray | null;
	while ((match = fence.exec(text)) !== null) {
		blocks.push(match[1] ?? "");
	}
	return blocks;
}

function extractLastJsonObject(text: string): string | undefined {
	const start = text.lastIndexOf("{");
	if (start < 0) return undefined;
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escape) { escape = false; continue; }
		if (ch === "\\") { escape = true; continue; }
		if (ch === '"') { inString = !inString; continue; }
		if (inString) continue;
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return undefined;
}

function coerceReport(parsed: Record<string, unknown>): WorkerReport | undefined {
	const summary = clampString(parsed.summary, REPORT_FIELD_BUDGETS.summary);
	const files = asStringArray(parsed.files, REPORT_FIELD_BUDGETS.file);
	const findings = asStringArray(parsed.findings, REPORT_FIELD_BUDGETS.item);
	const unresolved = asStringArray(parsed.unresolved, REPORT_FIELD_BUDGETS.item);
	if (!summary && files.length === 0 && findings.length === 0 && unresolved.length === 0) {
		return undefined;
	}
	return { summary, files, findings, unresolved };
}

export function parseWorkerReport(raw: string): WorkerReport {
	const text = raw.trim();
	if (!text) return emptyReport();

	const direct = tryParseJsonObject(text);
	if (direct) {
		const coerced = coerceReport(direct);
		if (coerced) return coerced;
	}

	const blocks = extractFencedJsonBlocks(text);
	for (let i = blocks.length - 1; i >= 0; i--) {
		const parsed = tryParseJsonObject(blocks[i]);
		if (parsed) {
			const coerced = coerceReport(parsed);
			if (coerced) return coerced;
		}
	}

	const lastObject = extractLastJsonObject(text);
	if (lastObject) {
		const parsed = tryParseJsonObject(lastObject);
		if (parsed) {
			const coerced = coerceReport(parsed);
			if (coerced) return coerced;
		}
	}

	const tail = text.slice(-FALLBACK_REPORT_BUDGET);
	return {
		summary: `Worker did not return a structured JSON report. Last ${tail.length} characters retained as fallback.`,
		files: [],
		findings: [tail],
		unresolved: ["Worker report parsing failed; structured fields unavailable."],
	};
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = asNumber(record[key]);
		if (value !== undefined) return value;
	}
	return undefined;
}

function pickCost(value: unknown): number | undefined {
	const numeric = asNumber(value);
	if (numeric !== undefined) return numeric;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return pickNumber(record, ["total", "totalCost", "cost"]);
	}
	return undefined;
}

export function extractUsageFromEvent(event: Record<string, unknown>): TaskUsage | undefined {
	const part = event.part && typeof event.part === "object"
		? event.part as Record<string, unknown>
		: undefined;

	// Real OpenCode step_finish: event.type='step_finish', part.type='step-finish',
	// part.tokens={total,input,output,reasoning,cache:{write,read}}, part.cost is a NUMBER.
	if (part?.type === "step-finish" || event.type === "step_finish") {
		const tokens = part?.tokens && typeof part.tokens === "object"
			? part.tokens as Record<string, unknown>
			: undefined;
		const costValue = part?.cost;
		if (!tokens && costValue === undefined) return undefined;
		const usage: TaskUsage = {};
		if (tokens) {
			usage.inputTokens = pickNumber(tokens, ["input", "inputTokens", "input_tokens", "prompt"]);
			usage.outputTokens = pickNumber(tokens, ["output", "outputTokens", "output_tokens", "completion"]);
			usage.totalTokens = pickNumber(tokens, ["total", "totalTokens", "total_tokens"]);
			usage.reasoningTokens = pickNumber(tokens, ["reasoning", "reasoningTokens", "reasoning_tokens"]);
			const cache = tokens.cache && typeof tokens.cache === "object"
				? tokens.cache as Record<string, unknown>
				: undefined;
			if (cache) {
				usage.cacheReadTokens = pickNumber(cache, ["read", "cacheRead", "cache_read", "cacheReadTokens", "cache_read_tokens"]);
				usage.cacheWriteTokens = pickNumber(cache, ["write", "cacheWrite", "cache_write", "cacheWriteTokens", "cache_write_tokens"]);
			}
		}
		const cost = pickCost(costValue);
		if (cost !== undefined) usage.cost = cost;
		return usage;
	}

	// Real Pi JSON message_end: event.message={role:'assistant', content:[{type:'text',text}],
	// usage:{input,output,cacheRead,cacheWrite,reasoning,totalTokens,cost:{total}}}.
	// Parse usage from event.message.usage (falling back to part.usage for older emitters).
	// Assistant text content is appended to task output by the manager, not here.
	if (event.type === "message_end" || part?.type === "message_end") {
		const message = event.message && typeof event.message === "object"
			? event.message as Record<string, unknown>
			: undefined;
		const usageSource = message?.usage ?? part?.usage;
		const usage = usageSource && typeof usageSource === "object"
			? usageSource as Record<string, unknown>
			: undefined;
		if (!usage) return undefined;
		const result: TaskUsage = {
			inputTokens: pickNumber(usage, ["input", "inputTokens", "input_tokens", "prompt_tokens"]),
			outputTokens: pickNumber(usage, ["output", "outputTokens", "output_tokens", "completion_tokens"]),
			totalTokens: pickNumber(usage, ["total", "totalTokens", "total_tokens"]),
			reasoningTokens: pickNumber(usage, ["reasoning", "reasoningTokens", "reasoning_tokens"]),
			cacheReadTokens: pickNumber(usage, ["cacheRead", "cacheReadTokens", "cache_read", "cache_read_tokens"]),
			cacheWriteTokens: pickNumber(usage, ["cacheWrite", "cacheWriteTokens", "cache_write", "cache_write_tokens"]),
		};
		const cost = pickCost(usage.cost);
		if (cost !== undefined) result.cost = cost;
		return result;
	}

	return undefined;
}

export function mergeUsage(current: TaskUsage | undefined, addition: TaskUsage): TaskUsage {
	const next: TaskUsage = { ...current };
	if (addition.inputTokens !== undefined) {
		next.inputTokens = (next.inputTokens ?? 0) + addition.inputTokens;
	}
	if (addition.outputTokens !== undefined) {
		next.outputTokens = (next.outputTokens ?? 0) + addition.outputTokens;
	}
	if (addition.totalTokens !== undefined) {
		next.totalTokens = (next.totalTokens ?? 0) + addition.totalTokens;
	}
	if (addition.cost !== undefined) {
		next.cost = (next.cost ?? 0) + addition.cost;
	}
	if (addition.cacheReadTokens !== undefined) {
		next.cacheReadTokens = (next.cacheReadTokens ?? 0) + addition.cacheReadTokens;
	}
	if (addition.cacheWriteTokens !== undefined) {
		next.cacheWriteTokens = (next.cacheWriteTokens ?? 0) + addition.cacheWriteTokens;
	}
	if (addition.reasoningTokens !== undefined) {
		next.reasoningTokens = (next.reasoningTokens ?? 0) + addition.reasoningTokens;
	}
	return next;
}
