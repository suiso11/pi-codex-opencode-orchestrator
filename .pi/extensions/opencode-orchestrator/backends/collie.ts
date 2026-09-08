import type { WorkerReport } from "../types.ts";
import { activityFromEvent, sanitizeActivityLabel, type BackendDecodedLine, type BackendDecodedStderrChunk, type BackendPreparation, type BackendSpawnInput, type WorkerBackendAdapter } from "./backend.ts";

const COLLIE_ENABLE_ENV = "PI_ORCH_ENABLE_COLLIE";

export function collieModelParts(model: string): { provider: string; model: string } {
	const slash = model.indexOf("/");
	const provider = slash < 0 ? "" : model.slice(0, slash).trim();
	const selectedModel = slash < 0 ? "" : model.slice(slash + 1).trim();
	if (!provider || !selectedModel) {
		throw new Error("Collie model must use provider/model format.");
	}
	return { provider, model: selectedModel };
}

export function collieGateError(input: Pick<BackendSpawnInput, "spec">, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env[COLLIE_ENABLE_ENV] !== "1") {
		return "Collie backend is disabled; set PI_ORCH_ENABLE_COLLIE=1 to opt in.";
	}
	if (input.spec.mode !== "write" || input.spec.role !== "implementer" || input.spec.worktree !== true) {
		return "Collie backend requires mode=write, role=implementer, and worktree=true.";
	}
	return undefined;
}

export function assertCollieAllowed(input: Pick<BackendSpawnInput, "spec">, env: NodeJS.ProcessEnv = process.env): void {
	const error = collieGateError(input, env);
	if (error) throw new Error(error);
}

function commonReportText(answer: unknown, error: unknown): string {
	if (typeof answer === "string") {
		try {
			const parsed: unknown = JSON.parse(answer);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return JSON.stringify(parsed);
		} catch {
			// A plain answer is wrapped below so the manager sees the common report shape.
		}
		return JSON.stringify({ summary: answer, files: [], findings: [], unresolved: [] });
	}
	if (answer && typeof answer === "object" && !Array.isArray(answer)) return JSON.stringify(answer);
	if (typeof error === "string" && error.trim()) {
		return JSON.stringify({ summary: "Collie worker error", files: [], findings: [], unresolved: [error] });
	}
	return "";
}

const COLLIE_ACTIVITY_TYPES = new Set(["progress"]);
const COLLIE_ACTIVITY_DETAILS = new Set(["streaming"]);

function stderrActivity(line: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const event = parsed as Record<string, unknown>;
		const type = typeof event.type === "string" && COLLIE_ACTIVITY_TYPES.has(event.type) ? event.type : undefined;
		if (!type) return undefined;
		const rawDetail = typeof event.message === "string" ? event.message : event.status;
		const detail = typeof rawDetail === "string" && COLLIE_ACTIVITY_DETAILS.has(rawDetail) ? rawDetail : undefined;
		return detail ? sanitizeActivityLabel(`${type}: ${detail}`) : undefined;
	} catch {
		return undefined;
	}
}

// Experimental Collie backend. Collie has no tool allowlist at this boundary;
// the backend is therefore fail-closed to the one isolated implementer route.
export class CollieBackendAdapter implements WorkerBackendAdapter {
	readonly id = "collie" as const;
	readonly displayName = "Collie";
	readonly binary: string;
	readonly binaryArgs: string[];

	constructor(options: { binary: string; binaryArgs?: string[] }) {
		this.binary = options.binary;
		this.binaryArgs = options.binaryArgs ?? [];
	}

	prepare(input: BackendSpawnInput): BackendPreparation {
		assertCollieAllowed(input);
		collieModelParts(input.model);
		return { activity: ["Collie isolated implementer"] };
	}

	buildArgs(input: BackendSpawnInput, _preparation: BackendPreparation): string[] {
		const selected = collieModelParts(input.model);
		return [
			...this.binaryArgs,
			"run",
			input.prompt,
			"--provider",
			selected.provider,
			"--model",
			selected.model,
			"--cwd",
			input.cwd,
			"--mode",
			"auto",
			"--json",
			"--stream-json",
		];
	}

	buildEnv(env: NodeJS.ProcessEnv, _input: BackendSpawnInput, _preparation?: BackendPreparation): NodeJS.ProcessEnv {
		return env;
	}

	cleanupAgent(_agentName: string | undefined, _preparation?: BackendPreparation): string | undefined {
		// Collie has no generated agent definition.
		return undefined;
	}

	decodeStdoutLine(_line: string, event: Record<string, unknown> | undefined): BackendDecodedLine {
		if (!event) return { output: undefined, activity: [] };
		const answer = commonReportText(event.answer, event.error);
		return {
			output: answer ? `${answer}\n` : undefined,
			activity: [activityFromEvent(event)],
		};
	}

	decodeStderrChunk(chunk: string): BackendDecodedStderrChunk {
		const activity: string[] = [];
		for (const line of chunk.split(/\r?\n/)) {
			if (!line.trim()) continue;
			const item = stderrActivity(line);
			if (item) activity.push(item);
		}
		return { text: chunk, activity };
	}

	normalizeExitReport(report: WorkerReport): WorkerReport {
		return report;
	}
}
