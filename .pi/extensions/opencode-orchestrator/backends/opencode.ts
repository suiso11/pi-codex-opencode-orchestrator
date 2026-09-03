import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelCapability, TaskSpec, ToolProfile, WorkerReport, WorkerRole } from "../types.ts";
import { enforceToolLimit, resolveToolProfile, TOOL_PROFILES, toolsForProfile } from "../types.ts";
import { activityFromEvent, type BackendDecodedLine, type BackendDecodedStderrChunk, type BackendPreparation, type BackendSpawnInput, type WorkerBackendAdapter } from "./backend.ts";

// The generated agent definition lives inside the per-spawn private runtime
// dir: `<runtimeDir>/opencode/agent/<name>.md`, where `<runtimeDir>/opencode`
// is exactly the directory forced as OPENCODE_CONFIG_DIR on the child.
function agentFilePath(configDir: string, name: string): string {
	return path.join(configDir, "agent", `${name}.md`);
}

// The OpenCode tool universe is the "full" profile. Start with a default
// deny so tools added by OpenCode, providers, or MCP cannot become ambiently
// available; explicit effective tools are allowed after that rule. MCP is
// separately opt-in because it is not part of the regular tool profiles.
export function agentFrontmatterFromTools(allowed: readonly string[], executor = false): string {
	const allowedSet = new Set(allowed);
	const allowedEntries = TOOL_PROFILES.full
		.filter((tool) => allowedSet.has(tool))
		.map((tool) => `  ${tool}: allow`);
	if (executor) allowedEntries.push('  "mcp.executor.*": allow');
	return [
		"---",
		"description: Pi orchestrator bounded worker",
		"mode: primary",
		"permission:",
		'  "*": deny',
		...allowedEntries,
		"---",
	].join("\n");
}

function writeAgentDefinition(configDir: string, taskId: string, allowedTools: readonly string[], executor = false): string {
	const frontmatter = agentFrontmatterFromTools(allowedTools, executor);
	const body = "You are a bounded worker delegated by a parent Pi orchestrator. Follow the repository's AGENTS.md. Do not read secrets or git-ignored runtime configuration. Stay within the declared scope and report missing scope instead of broadening the task.";
	const dir = path.join(configDir, "agent");
	mkdirSync(dir, { recursive: true });
	const name = `pi-orch-${taskId}-${randomBytes(4).toString("hex")}`;
	const file = agentFilePath(configDir, name);
	writeFileSync(file, `${frontmatter}
${body}
`, { encoding: "utf-8" });
	return name;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface RolePermissionOverride {
	edit: "deny";
	bash: "deny" | Record<string, "allow">;
}

const EXECUTOR_ENABLE_ENV = "PI_ORCH_ENABLE_EXECUTOR";
const EXECUTOR_CONFIG_KEY = "executor";

export function executorGateError(
	input: Pick<BackendSpawnInput, "spec" | "model">,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (input.spec.executor !== true) return undefined;
	if (env[EXECUTOR_ENABLE_ENV] !== "1") {
		return "Executor MCP is disabled; set PI_ORCH_ENABLE_EXECUTOR=1 to opt in.";
	}
	if (input.spec.role !== "implementer") {
		return "Executor MCP requires the explicit implementer role.";
	}
	if (input.model.startsWith("pi::") || input.model.startsWith("collie::")) {
		return "Executor MCP requires the OpenCode backend.";
	}
	return undefined;
}

function executorCommand(env: NodeJS.ProcessEnv): string[] {
	return [env.PI_EXECUTOR_BIN || "executor", "mcp", "--elicitation-mode", "browser", "--no-artifacts", "--search-tools"];
}

// Official permission semantics: edit covers edit/write/patch, and the last
// matching bash rule wins. The forced bash override is therefore appended as the
// last rule so it wins for any matching command. Bash immutability is never claimed.
function rolePermissionOverride(role: WorkerRole | undefined): RolePermissionOverride | undefined {
	if (role === "tester") return { edit: "deny", bash: { "*": "allow" } };
	if (role === "reviewer") return { edit: "deny", bash: "deny" };
	return undefined;
}

/**
 * Build the forced inline config for an OpenCode worker child, fail-closed.
 * Ambient OPENCODE_CONFIG_CONTENT is never merged or preserved: the returned
 * config contains only the manager-generated role permission override and,
 * for explicitly opted-in Executor tasks, the single manager-generated
 * mcp.executor entry. Returns undefined when neither is present; the caller
 * then removes OPENCODE_CONFIG_CONTENT from the child environment entirely.
 */
export function buildOpenCodeConfigContent(
	role: WorkerRole | undefined,
	executor = false,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const override = rolePermissionOverride(role);
	if (!override && !executor) return undefined;
	const config: Record<string, unknown> = {};
	if (override) {
		// Official permission semantics: edit covers edit/write/patch, and the
		// last matching bash rule wins. The forced bash rule is the only rule
		// and therefore always wins; bash immutability is never claimed.
		config.permission = override.bash === "deny"
			? { edit: override.edit, bash: "deny" }
			: { edit: override.edit, bash: { "*": override.bash["*"] } };
	}
	if (executor) {
		config.mcp = { [EXECUTOR_CONFIG_KEY]: { type: "local", command: executorCommand(env) } };
	}
	return JSON.stringify(config);
}

// Effective OpenCode tool set: the mode-filtered profile with bash restored
// for the tester role. `toolsForProfile` strips bash for read_only, which
// would silently break the tester contract ("bash is enabled for running
// tests and verification commands" even in read_only mode, enforced by the
// role permission override below and matching the Pi backend's tool list).
// edit/write stay excluded for every role. bash is a required tester slot: it
// is placed first so the head-truncating maxTools reduction can never drop
// verification shell access; roles whose profile already includes bash keep
// the profile order unchanged.
export function effectiveWorkerTools(
	spec: Pick<TaskSpec, "mode" | "role" | "toolProfile">,
	fallback: ToolProfile,
): readonly string[] {
	const tools = toolsForProfile(resolveToolProfile(spec, fallback), spec.mode);
	if (spec.role !== "tester" || tools.includes("bash")) return tools;
	return ["bash", ...tools];
}

// OpenCode worker child construction. The tool allowlist is owned by a
// generated agent definition (so the parent controls the tool set instead of
// inheriting ambient OpenCode config); the definition is built from the
// effective tool set, i.e. the role-aware profile after maxTools reduction
// (tester bash is a required slot), so tools trimmed by a model capability are
// actually denied. Role workers get a manager-generated permission config;
// ambient inline config is discarded rather than merged.
export class OpenCodeBackendAdapter implements WorkerBackendAdapter {
	readonly id = "opencode" as const;
	readonly displayName = "OpenCode";
	readonly binary: string;
	readonly binaryArgs: string[];
	private readonly defaultToolProfile: ToolProfile;
	private readonly modelCapabilities: Record<string, ModelCapability>;

	constructor(options: {
		binary: string;
		binaryArgs: string[];
		defaultToolProfile: ToolProfile;
		modelCapabilities: Record<string, ModelCapability>;
	}) {
		this.binary = options.binary;
		this.binaryArgs = options.binaryArgs;
		this.defaultToolProfile = options.defaultToolProfile;
		this.modelCapabilities = options.modelCapabilities;
	}

	prepare(input: BackendSpawnInput): BackendPreparation {
		const profile = resolveToolProfile(input.spec, this.defaultToolProfile);
		const capability = this.modelCapabilities[input.model];
		const tools = enforceToolLimit(effectiveWorkerTools(input.spec, this.defaultToolProfile), capability);
		// Private per-spawn runtime isolation: a fresh mkdtemp directory holds
		// the generated agent definition under its OpenCode config dir, so the
		// worker never reads or writes the user's ambient OpenCode config.
		const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "pi-opencode-worker-"));
		const configDir = path.join(runtimeDir, "opencode");
		try {
			const agentName = writeAgentDefinition(configDir, input.taskId, tools.tools, input.spec.executor === true);
			const activity = [`agent profile: ${profile} (${tools.tools.join(",")})`];
			if (tools.reduced && tools.reason) activity.push(`capability: ${tools.reason}`);
			return { agentName, runtimeDir, configDir, activity };
		} catch (error) {
			try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* preserve preparation failure */ }
			throw error;
		}
	}

	buildArgs(input: BackendSpawnInput, preparation: BackendPreparation): string[] {
		return [
			...this.binaryArgs,
			"run",
			// Official CLI flag (1.18.18): run without ambient user config side effects.
			"--pure",
			"--format",
			"json",
			"--model",
			input.model,
			"--variant",
			input.thinking,
			...(preparation.agentName ? ["--agent", preparation.agentName] : []),
			input.prompt,
		];
	}

	buildEnv(env: NodeJS.ProcessEnv, input: BackendSpawnInput, preparation: BackendPreparation): NodeJS.ProcessEnv {
		if (!preparation.runtimeDir || !preparation.configDir) {
			throw new Error("OpenCode worker preparation is missing its private config directories.");
		}
		const next: NodeJS.ProcessEnv = { ...env };
		// Fail-closed: ambient OpenCode config selectors and inline config are
		// discarded; the child only ever sees the manager-generated config.
		delete next.OPENCODE_CONFIG;
		delete next.XDG_CONFIG_DIRS;
		const forced = buildOpenCodeConfigContent(input.spec.role, input.spec.executor === true, env);
		if (forced === undefined) delete next.OPENCODE_CONFIG_CONTENT;
		else next.OPENCODE_CONFIG_CONTENT = forced;
		// Private per-spawn config isolation: ambient global/project config,
		// plugins, and MCP servers cannot reach the worker. HOME/USERPROFILE/
		// XDG_DATA_HOME/LOCALAPPDATA are deliberately left untouched so saved
		// CLI authentication keeps working. XDG_CONFIG_HOME is the exception:
		// it is private above so global config cannot leak into this worker.
		next.OPENCODE_CONFIG_DIR = preparation.configDir;
		next.XDG_CONFIG_HOME = preparation.runtimeDir;
		next.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
		return next;
	}

	cleanupAgent(agentName: string | undefined, preparation?: BackendPreparation): string | undefined {
		if (!preparation?.runtimeDir) return undefined;
		const errors: string[] = [];
		if (agentName && preparation.configDir) {
			try { unlinkSync(agentFilePath(preparation.configDir, agentName)); } catch (error) {
				const code = (error as NodeJS.ErrnoException | null)?.code;
				if (code !== "ENOENT") errors.push(`agent definition cleanup failed: ${errorMessage(error)}`);
			}
		}
		try { rmSync(preparation.runtimeDir, { recursive: true, force: true }); } catch (error) {
			errors.push(`runtime dir cleanup failed: ${errorMessage(error)}`);
		}
		return errors.length > 0 ? errors.join("; ") : undefined;
	}

	// OpenCode output decoding: text streaming events (`type: "text"` with
	// `part.text`) are the primary output path and are appended to the raw
	// output; every structured event contributes an activity label. Raw
	// non-JSON diagnostic lines are retained verbatim in the raw output only.
	decodeStdoutLine(line: string, event: Record<string, unknown> | undefined): BackendDecodedLine {
		if (!event) return { output: `${line}\n`, activity: [] };
		const part = event.part && typeof event.part === "object"
			? event.part as Record<string, unknown>
			: undefined;
		let output: string | undefined;
		if (event.type === "text" && part && typeof part.text === "string") {
			output = `${part.text}\n`;
		}
		return { output, activity: [activityFromEvent(event)] };
	}

	decodeStderrChunk(chunk: string): BackendDecodedStderrChunk {
		return { text: chunk, activity: [] };
	}

	normalizeExitReport(report: WorkerReport): WorkerReport {
		return report;
	}
}
