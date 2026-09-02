import type { TaskSpec, ThinkingLevel, WorkerBackend } from "../types.ts";

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

// Backend-specific child-process construction boundary. Implementations must
// preserve the exact public CLI argument, environment, and permission
// semantics for their backend, including pi:: model encoding handled upstream
// by the manager.
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
}
