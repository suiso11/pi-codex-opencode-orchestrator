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
}

// Backend-prepared spawn state. `agentName` is the backend-scoped tool
// allowlist handle the manager must pass back to cleanupAgent when the child
// exits or times out. `activity` items are appended to the task snapshot by
// the manager (snapshot state stays manager-owned).
export interface BackendPreparation {
	agentName?: string;
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

// Backend-neutral activity label for one structured JSON event. Both current
// backends share this part-based decoding (`tool: status`, `step finished:
// reason`, or `type: partType`); it is applied to every parsed event.
export function activityFromEvent(event: Record<string, unknown>): string {
	const part = event.part && typeof event.part === "object"
		? event.part as Record<string, unknown>
		: undefined;
	const type = typeof event.type === "string" ? event.type : "event";
	if (!part) return type;
	if (part.type === "tool") {
		const tool = typeof part.tool === "string" ? part.tool : "tool";
		const state = part.state && typeof part.state === "object"
			? part.state as Record<string, unknown>
			: undefined;
		const status = state && typeof state.status === "string" ? state.status : "update";
		return `${tool}: ${status}`;
	}
	if (part.type === "step-finish") {
		return `step finished: ${typeof part.reason === "string" ? part.reason : "unknown"}`;
	}
	return `${type}: ${String(part.type ?? "unknown")}`;
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
	buildEnv(env: NodeJS.ProcessEnv, input: BackendSpawnInput): NodeJS.ProcessEnv;
	cleanupAgent(agentName: string | undefined): void;
	// Decode one raw stdout line from the worker child. `event` is the parsed
	// JSON object when the line parsed as a JSON object, otherwise undefined.
	// Implementations must preserve the exact raw-output text and activity
	// decoding of their backend for both raw and structured lines.
	decodeStdoutLine(line: string, event: Record<string, unknown> | undefined): BackendDecodedLine;
	// Decode one raw stderr chunk from the worker child. The returned text is
	// what the manager bounds and stores as snapshot.stderr; identity by
	// default for the current backends.
	decodeStderrChunk(chunk: string): string;
	// Normalize the structured report parsed from the final raw output at child
	// exit, before any manager-owned worktree path normalization. Identity for
	// the current backends; this is the exit-time normalization hook.
	normalizeExitReport(report: WorkerReport): WorkerReport;
}
