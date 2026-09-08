import type { TaskSpec, ThinkingLevel, WorkerBackend, WorkerReport } from "../types.ts";

// Per-spawn input every backend adapter needs to build its child process.
// Scheduling, task snapshot state, output parsing, and Git/worktree handling
// stay in the manager; adapters own only command/args/env/tool-allowlist and
// agent-definition details for their backend.
export interface BackendSpawnInput {
	taskId: string;
	spec: TaskSpec;
	model: string;
	thinking: ThinkingLevel;
	prompt: string;
	// Child working directory. For worktree tasks this is the manager-created
	// isolated worktree path; backends that pass --cwd (e.g. Collie) forward it
	// verbatim. It is never placed into prompts.
	cwd: string;
}

// Backend-prepared spawn state. `agentName` is the backend-scoped tool
// allowlist handle the manager must pass back to cleanupAgent when the child
// exits or times out. `activity` items are appended to the task snapshot by
// the manager (snapshot state stays manager-owned).
//
// OpenCode additionally prepares a private per-spawn runtime directory:
// `runtimeDir` is the mkdtemp root (forced as the child's XDG_CONFIG_HOME) and
// `configDir` is the OpenCode config dir under it (forced as
// OPENCODE_CONFIG_DIR), holding the generated `agent/` definition. Both are
// removed again by cleanupAgent. Other backends leave them undefined.
export interface BackendPreparation {
	agentName?: string;
	runtimeDir?: string;
	configDir?: string;
	activity: string[];
}

// Decoded result for one raw stdout line from a worker child. `output` is the
// newline-terminated text to append to the task snapshot's raw output
// (undefined appends nothing); `activity` items are appended to the snapshot's
// activity list. The manager owns line buffering, bounded storage and
// bounding, and usage extraction/merge; adapters own only backend-specific
// output-text extraction and activity decoding.
export interface BackendDecodedLine {
	output?: string;
	activity: string[];
}

// Concise, safe worker-activity labels. Labels are always `tool: status`
// plus an optional non-sensitive file-ish target; raw reasoning text, full
// shell commands, secrets, and absolute managed-worktree paths are never
// included. Every label is whitespace-collapsed, redacted, and bounded.
export const MAX_ACTIVITY_LABEL_CHARS = 120;

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*m/g;
const SECRET_PATTERNS: RegExp[] = [
	/\bsk-[A-Za-z0-9-_]{4,}/g,
	/\bbearer\s+[A-Za-z0-9\-._~+/=]{4,}/gi,
	/\b(api[_-]?key|password|passwd|secret|token)\s*[:=]\s*\S+/gi,
];
const ABS_WIN_PATH_PATTERN = /[A-Za-z]:[\\/][^\s"'`,;]*/g;
const ABS_TMP_PATH_PATTERN = /\/(?:tmp|home|Users|root|var|private|mnt)[^\s"'`,;]*/g;

function basenameOf(value: string): string {
	const normalized = value.replace(/\\/g, "/");
	const base = normalized.slice(normalized.lastIndexOf("/") + 1);
	return base || normalized;
}

function redactSecretsAndPaths(value: string): string {
	let out = value.replace(ANSI_ESCAPE_PATTERN, "");
	for (const pattern of SECRET_PATTERNS) {
		pattern.lastIndex = 0;
		out = out.replace(pattern, "[redacted]");
	}
	// Absolute managed paths never appear verbatim: keep only the basename so
	// a file-ish target stays useful without exposing the temp layout.
	out = out.replace(ABS_WIN_PATH_PATTERN, (match) => `<path>/${basenameOf(match)}`);
	out = out.replace(ABS_TMP_PATH_PATTERN, (match) => `<path>/${basenameOf(match)}`);
	return out;
}

/** Collapse whitespace, redact secrets/absolute paths, and bound length. */
export function sanitizeActivityLabel(label: string, maxChars = MAX_ACTIVITY_LABEL_CHARS): string {
	const collapsed = label.replace(/\s+/g, " ").trim();
	const redacted = redactSecretsAndPaths(collapsed);
	if (redacted.length <= maxChars) return redacted || "update";
	const truncated = redacted.slice(0, Math.max(0, maxChars - 1)).trimEnd();
	return `${truncated}…` || "update";
}

function asSafeTarget(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	let trimmed = value.trim();
	if (!trimmed || /\r|\n/.test(trimmed)) return undefined;
	// Long safe file-ish paths retain their useful basename rather than losing
	// all target context. Other long free-form values remain rejected.
	if (trimmed.length > 80 && (trimmed.includes("/") || trimmed.includes("\\"))) {
		trimmed = basenameOf(trimmed);
	}
	if (!trimmed || trimmed.length > 80) return undefined;
	// Never surface shell commands, flags, secrets, or JSON blobs as targets.
	if (/[;&|`$()]/.test(trimmed) || /\s{2,}/.test(trimmed)) return undefined;
	if (/^(?:sk-|bearer\s)/i.test(trimmed) || /(?:password|secret|token|api[_-]?key)\s*[:=]/i.test(trimmed)) return undefined;
	if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.includes("\0")) return undefined;
	const words = trimmed.split(/\s+/);
	if (words.length > 3) return undefined;
	// Absolute paths collapse to their basename; only file-ish tokens survive.
	if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("/")) return basenameOf(trimmed);
	if (!/^[\w\-.+/@]{1,80}$/.test(words[0] ?? "")) return undefined;
	const candidate = words.length === 1 ? trimmed : words[0];
	if (!/[\w]/.test(candidate)) return undefined;
	return candidate.slice(0, 48);
}

function safeTargetFromPart(part: Record<string, unknown>): string | undefined {
	const keys = ["file", "filePath", "filename", "path", "target", "name"];
	for (const key of keys) {
		const target = asSafeTarget(part[key]);
		if (target) return target;
	}
	const inputs = [part.input, part.state && typeof part.state === "object" ? (part.state as Record<string, unknown>).input : undefined];
	for (const input of inputs) {
	if (input && typeof input === "object" && !Array.isArray(input)) {
		for (const key of keys) {
			const target = asSafeTarget((input as Record<string, unknown>)[key]);
			if (target) return target;
		}
	}
	}
	return undefined;
}

// Backend-neutral activity label for one structured JSON event. Both current
// backends share this part-based decoding (`tool: status [target]`,
// `step finished: reason`, or `type: partType`); it is applied to every
// parsed event. Only the tool name, its status, and an optional safe file-ish
// target are surfaced; reasoning text, commands, and secrets are dropped.
export function activityFromEvent(event: Record<string, unknown>): string {
	const part = event.part && typeof event.part === "object"
		? event.part as Record<string, unknown>
		: undefined;
	const rawType = typeof event.type === "string" ? event.type : "";
	const type = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(rawType) ? rawType : "event";
	if (!part) return sanitizeActivityLabel(type);
	if (part.type === "tool") {
		const rawTool = typeof part.tool === "string" ? part.tool : "tool";
		const tool = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(rawTool) ? rawTool : "tool";
		// An absolute path smuggled as the tool name (used by redaction tests)
		// must never surface verbatim; surface the safe marker instead so live
		// progress and settled activity stay leak-free without raw paths.
		const toolWasAbsolute = typeof rawTool === "string" &&
			(/^[A-Za-z]:[\\/]/.test(rawTool) || (rawTool.startsWith("/") && rawTool.includes("/")));
		const state = part.state && typeof part.state === "object"
			? part.state as Record<string, unknown>
			: undefined;
		const rawStatus = state && typeof state.status === "string" ? state.status : "update";
		const status = /^[A-Za-z][A-Za-z0-9 _-]{0,31}$/.test(rawStatus) ? rawStatus : "update";
		const target = part.tool === "bash" ? undefined : safeTargetFromPart(part);
		const suffix = toolWasAbsolute ? " <worktree>" : "";
		return sanitizeActivityLabel(target ? `${tool}: ${status} ${target}${suffix}` : `${tool}: ${status}${suffix}`);
	}
	if (part.type === "step-finish") {
		const reason = typeof part.reason === "string" && /^[A-Za-z][A-Za-z0-9 _-]{0,31}$/.test(part.reason)
			? part.reason
			: "unknown";
		return sanitizeActivityLabel(`step finished: ${reason}`);
	}
	const partType = typeof part.type === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(part.type)
		? part.type
		: "unknown";
	return sanitizeActivityLabel(`${type}: ${partType}`);
}

// Decoded result for one raw stderr chunk from the worker child. `text` is
// what the manager bounds and stores as snapshot.stderr; `activity` items are
// appended to the snapshot's activity list. The manager owns bounding and
// snapshot application; adapters own backend-specific stderr decoding (e.g.
// extracting activity labels from NDJSON diagnostic events).
export interface BackendDecodedStderrChunk {
	text: string;
	activity: string[];
}

// Backend-specific child-process construction boundary. Implementations must
// preserve the exact public CLI argument, environment, and permission
// semantics for their backend, including pi:: model encoding handled upstream
// by the manager.
//
// The output protocol methods below are the backend-specific output boundary:
// stdout/stderr event decoding and exit-time report normalization. The
// manager owns scheduling, snapshot state, bounded storage, usage
// extraction/merge, worktree report path normalization, and Git handling;
// adapters own only decoding/normalization details for their backend.
export interface WorkerBackendAdapter {
	readonly id: WorkerBackend;
	// Human-facing backend label used verbatim in timeout/exit/error messages.
	readonly displayName: string;
	readonly binary: string;
	readonly binaryArgs: string[];
	prepare(input: BackendSpawnInput): BackendPreparation;
	buildArgs(input: BackendSpawnInput, preparation: BackendPreparation): string[];
	buildEnv(env: NodeJS.ProcessEnv, input: BackendSpawnInput, preparation: BackendPreparation): NodeJS.ProcessEnv;
	// Remove any backend-generated agent definition and per-spawn runtime
	// state (for OpenCode: the agent file plus the whole private runtime dir,
	// recursively). Returns an error message when cleanup failed so the
	// manager can surface it as activity/error, or undefined on success.
	cleanupAgent(agentName: string | undefined, preparation?: BackendPreparation): string | undefined;
	// Decode one raw stdout line from the worker child. `event` is the parsed
	// JSON object when the line parsed as a JSON object, otherwise undefined.
	// Implementations must preserve the exact raw-output text and activity
	// decoding of their backend for both raw and structured lines.
	decodeStdoutLine(line: string, event: Record<string, unknown> | undefined): BackendDecodedLine;
	// Decode one raw stderr chunk from the worker child. `text` is what the
	// manager bounds and stores as snapshot.stderr (identity for the current
	// OpenCode/Pi backends); `activity` items become bounded snapshot activity
	// labels without changing the retained raw stderr text.
	decodeStderrChunk(chunk: string): BackendDecodedStderrChunk;
	// Normalize the structured report parsed from the final raw output at child
	// exit, before any manager-owned worktree path normalization. Identity for
	// the current backends; this is the exit-time normalization hook.
	normalizeExitReport(report: WorkerReport): WorkerReport;
}
