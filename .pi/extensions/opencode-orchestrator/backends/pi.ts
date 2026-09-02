import type { TaskSpec } from "../types.ts";
import type { BackendPreparation, BackendSpawnInput, WorkerBackendAdapter } from "./backend.ts";

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

	buildEnv(env: NodeJS.ProcessEnv, _input: BackendSpawnInput): NodeJS.ProcessEnv {
		return env;
	}

	cleanupAgent(_agentName: string | undefined): void {
		// Pi has no agent definition to clean up.
	}
}
