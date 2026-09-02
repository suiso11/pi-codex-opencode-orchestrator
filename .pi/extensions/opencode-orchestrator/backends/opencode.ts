import { randomBytes } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelCapability, TaskMode, ToolProfile, WorkerReport, WorkerRole } from "../types.ts";
import { buildAgentFrontmatter, enforceToolLimit, resolveToolProfile, toolsForProfile } from "../types.ts";
import { activityFromEvent, type BackendDecodedLine, type BackendDecodedStderrChunk, type BackendPreparation, type BackendSpawnInput, type WorkerBackendAdapter } from "./backend.ts";

function opencodeAgentDir(): string {
	// OpenCode resolves agents by name from ~/.config/opencode/agent/ on every platform.
	return path.join(os.homedir(), ".config", "opencode", "agent");
}

function writeAgentDefinition(taskId: string, profile: ToolProfile, mode: TaskMode): string {
	const frontmatter = buildAgentFrontmatter(profile, mode);
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
 * non-forced permission keys are preserved; an invalid existing value is
 * ignored in favor of the forced override. Returns undefined when no override
 * applies and nothing valid is present.
 */
export function buildOpenCodeConfigContent(
	role: WorkerRole | undefined,
	existingContent: string | undefined,
): string | undefined {
	const override = rolePermissionOverride(role);
	if (!override) return existingContent;
	let base: Record<string, unknown> = {};
	if (existingContent) {
		try {
			const parsed: unknown = JSON.parse(existingContent);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				base = parsed as Record<string, unknown>;
			}
		} catch {
			// Invalid existing inline config is ignored; the override still applies.
		}
	}
	const permission = base.permission && typeof base.permission === "object" && !Array.isArray(base.permission)
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
	return JSON.stringify({ ...base, permission });
}

// OpenCode worker child construction. The tool allowlist is owned by a
// generated agent definition (so the parent controls the tool set instead of
// inheriting ambient OpenCode config), and role workers get a forced official
// permission override merged over any valid inline config.
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
		const tools = enforceToolLimit(toolsForProfile(profile, input.spec.mode), capability);
		const agentName = writeAgentDefinition(input.taskId, profile, input.spec.mode);
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
		const mergedConfig = buildOpenCodeConfigContent(input.spec.role, env.OPENCODE_CONFIG_CONTENT);
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
