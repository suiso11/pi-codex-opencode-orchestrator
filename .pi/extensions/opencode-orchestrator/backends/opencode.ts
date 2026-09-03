import { randomBytes } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelCapability, TaskSpec, ToolProfile, WorkerReport, WorkerRole } from "../types.ts";
import { enforceToolLimit, resolveToolProfile, TOOL_PROFILES, toolsForProfile } from "../types.ts";
import { activityFromEvent, type BackendDecodedLine, type BackendDecodedStderrChunk, type BackendPreparation, type BackendSpawnInput, type WorkerBackendAdapter } from "./backend.ts";

function opencodeAgentDir(): string {
	// OpenCode resolves agents by name from ~/.config/opencode/agent/ on every platform.
	return path.join(os.homedir(), ".config", "opencode", "agent");
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

function writeAgentDefinition(taskId: string, allowedTools: readonly string[], executor = false): string {
	const frontmatter = agentFrontmatterFromTools(allowedTools, executor);
	const body = "You are a bounded worker delegated by a parent Pi orchestrator. Follow the repository's AGENTS.md. Do not read secrets or git-ignored runtime configuration. Stay within the declared scope and report missing scope instead of broadening the task.";
	const dir = opencodeAgentDir();
	mkdirSync(dir, { recursive: true });
	const name = `pi-orch-${taskId}-${randomBytes(4).toString("hex")}`;
	const file = path.join(dir, `${name}.md`);
	writeFileSync(file, `${frontmatter}
${body}
`, { encoding: "utf-8" });
	return name;
}

function cleanupAgentDefinition(name: string | undefined) {
	if (!name) return;
	const file = path.join(opencodeAgentDir(), `${name}.md`);
	try { unlinkSync(file); } catch { /* already removed or missing */ }
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
 * Merge a valid existing OPENCODE_CONFIG_CONTENT with the role-specific
 * permission override for the OpenCode child. Any existing top-level keys and
 * non-forced permission keys are preserved, except ambient MCP servers; an
 * invalid existing value is ignored in favor of the forced override. Executor
 * mode installs only the manager-generated mcp.executor entry. Returns
 * undefined when no existing config or forced setting is present.
 */
export function buildOpenCodeConfigContent(
	role: WorkerRole | undefined,
	existingContent: string | undefined,
	executor = false,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const override = rolePermissionOverride(role);
	if (!override && !executor && !existingContent) return undefined;
	let base: Record<string, unknown> = {};
	let parsedExisting = false;
	if (existingContent) {
		try {
			const parsed: unknown = JSON.parse(existingContent);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				base = parsed as Record<string, unknown>;
				parsedExisting = true;
			}
		} catch {
			// Invalid existing inline config is ignored when a forced config is
			// needed; otherwise preserve it so OpenCode reports the parse error.
			if (!override && !executor) return existingContent;
		}
	}
	// Never inherit ambient MCP servers. The only MCP entry a worker may see is
	// the manager-generated Executor gateway below when explicitly opted in.
	const hadAmbientMcp = Object.prototype.hasOwnProperty.call(base, "mcp");
	delete base.mcp;
	let permission: Record<string, unknown> | undefined;
	if (override) {
		permission = base.permission && typeof base.permission === "object" && !Array.isArray(base.permission)
			? { ...(base.permission as Record<string, unknown>) }
			: {};
		permission.edit = override.edit;
		if (override.bash === "deny") {
			permission.bash = "deny";
		} else {
			const existingBash = permission.bash && typeof permission.bash === "object" && !Array.isArray(permission.bash)
				? { ...(permission.bash as Record<string, unknown>) }
				: {};
			// Remove any prior "*" rule and re-insert it last so the forced override
			// is the final matching bash rule.
			delete existingBash["*"];
			existingBash["*"] = override.bash["*"];
			permission.bash = existingBash;
		}
	}
	if (executor) {
		const mcp = base.mcp && typeof base.mcp === "object" && !Array.isArray(base.mcp)
			? { ...(base.mcp as Record<string, unknown>) }
			: {};
		mcp[EXECUTOR_CONFIG_KEY] = { type: "local", command: executorCommand(env) };
		base.mcp = mcp;
	}
	if (!override && !executor && parsedExisting && !hadAmbientMcp) return existingContent;
	return JSON.stringify({ ...base, ...(override ? { permission } : {}) });
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
// actually denied. Role workers get a forced official permission override
// merged over any valid inline config.
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
		const agentName = writeAgentDefinition(input.taskId, tools.tools, input.spec.executor === true);
		const activity = [`agent profile: ${profile} (${tools.tools.join(",")})`];
		if (tools.reduced && tools.reason) activity.push(`capability: ${tools.reason}`);
		return { agentName, activity };
	}

	buildArgs(input: BackendSpawnInput, preparation: BackendPreparation): string[] {
		return [
			...this.binaryArgs,
			"run",
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

	buildEnv(env: NodeJS.ProcessEnv, input: BackendSpawnInput): NodeJS.ProcessEnv {
		const mergedConfig = buildOpenCodeConfigContent(
			input.spec.role,
			env.OPENCODE_CONFIG_CONTENT,
			input.spec.executor === true,
			env,
		);
		if (mergedConfig === undefined || mergedConfig === env.OPENCODE_CONFIG_CONTENT) return env;
		return { ...env, OPENCODE_CONFIG_CONTENT: mergedConfig };
	}

	cleanupAgent(agentName: string | undefined): void {
		cleanupAgentDefinition(agentName);
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
