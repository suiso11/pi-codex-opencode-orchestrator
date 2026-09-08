import type { TaskSpec, WorkerReport } from "../types.ts";
import { activityFromEvent, type BackendDecodedLine, type BackendDecodedStderrChunk, type BackendPreparation, type BackendSpawnInput, type WorkerBackendAdapter } from "./backend.ts";

// Exact Pi child tool lists. Existing unroled read/write behavior is preserved;
// tester additionally gets bash (but no edit/write), and reviewer is strictly
// read/grep/find/ls.
export function piToolList(spec: Pick<TaskSpec, "mode" | "role">) {
	if (spec.role === "reviewer") return "read,grep,find,ls";
	if (spec.role === "tester") return "read,grep,find,ls,bash";
	return spec.mode === "read_only" ? "read,grep,find,ls" : "read,grep,find,ls,bash,edit,write";
}

// Pi worker child construction. Pi workers pass --tools explicitly, so no
// agent definition is written and no cleanup is required.
export class PiBackendAdapter implements WorkerBackendAdapter {
	readonly id = "pi" as const;
	readonly displayName = "Pi";
	readonly binary: string;
	readonly binaryArgs: string[];

	constructor(options: { binary: string; binaryArgs: string[] }) {
		this.binary = options.binary;
		this.binaryArgs = options.binaryArgs;
	}

	prepare(_input: BackendSpawnInput): BackendPreparation {
		return { activity: [] };
	}

	buildArgs(input: BackendSpawnInput, _preparation: BackendPreparation): string[] {
		return [
			...this.binaryArgs,
			"--approve",
			"--no-session",
			"--no-extensions",
			"--mode",
			"json",
			"--model",
			input.model,
			"--thinking",
			input.thinking,
			"--tools",
			piToolList(input.spec),
			input.prompt,
		];
	}

	buildEnv(env: NodeJS.ProcessEnv, _input: BackendSpawnInput, _preparation?: BackendPreparation): NodeJS.ProcessEnv {
		return env;
	}

	cleanupAgent(_agentName: string | undefined, _preparation?: BackendPreparation): string | undefined {
		// Pi has no agent definition to clean up.
		return undefined;
	}

	// Pi output decoding: assistant text is appended at message_end (not
	// message_update, to avoid double-counting streaming deltas); every
	// structured event contributes an activity label. Raw non-JSON lines are
	// retained verbatim in the raw output and marked as streaming activity.
	decodeStdoutLine(line: string, event: Record<string, unknown> | undefined): BackendDecodedLine {
		if (!event) return { output: `${line}\n`, activity: ["Pi response streaming"] };
		let output: string | undefined;
		// Preserve the manager's historical shared text-event behavior: test
		// harnesses and compatible wrappers may emit OpenCode-style text events
		// even when the selected backend is Pi.
		const part = event.part && typeof event.part === "object"
			? event.part as Record<string, unknown>
			: undefined;
		if (event.type === "text" && typeof part?.text === "string") {
			output = `${part.text}\n`;
		} else if (event.type === "message_end") {
			const message = event.message && typeof event.message === "object"
				? event.message as Record<string, unknown>
				: undefined;
			const content = message?.content;
			if (Array.isArray(content)) {
				for (const item of content) {
					if (item && typeof item === "object") {
						const node = item as Record<string, unknown>;
						if (node.type === "text" && typeof node.text === "string") {
							output = `${output ?? ""}${node.text}\n`;
						}
					}
				}
			}
		}
		const activityEvent = event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end"
			? {
				type: event.type,
				part: {
					type: "tool",
					// Pi's documented shape uses top-level toolName and args. Keep
					// the older fields as a compatibility fallback.
					tool: typeof event.toolName === "string" ? event.toolName : (typeof event.tool === "string" ? event.tool : "tool"),
					state: {
						status: (typeof event.toolName === "string" || (event.args && typeof event.args === "object"))
							? (event.type === "tool_execution_end" ? (event.isError === true ? "error" : "completed") : "running")
							: (typeof event.status === "string" ? event.status : "update"),
					},
					input: event.args && typeof event.args === "object"
						? event.args
						: (event.input && typeof event.input === "object" ? event.input : undefined),
				},
			} as Record<string, unknown>
			: event;
		return { output, activity: [activityFromEvent(activityEvent)] };
	}

	decodeStderrChunk(chunk: string): BackendDecodedStderrChunk {
		return { text: chunk, activity: [] };
	}

	normalizeExitReport(report: WorkerReport): WorkerReport {
		return report;
	}
}
