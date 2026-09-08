import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import { activityFromEvent, type BackendSpawnInput, type WorkerBackendAdapter } from "./backends/backend.ts";
import {
	agentFrontmatterFromTools,
	buildOpenCodeConfigContent,
	effectiveWorkerTools,
	executorGateError,
	OpenCodeBackendAdapter,
} from "./backends/opencode.ts";
import { CollieBackendAdapter, collieGateError } from "./backends/collie.ts";
import { PiBackendAdapter, piToolList } from "./backends/pi.ts";
import { TOOL_PROFILES } from "./types.ts";
import type { TaskSpec, WorkerReport } from "./types.ts";

function spawnInput(overrides: Partial<BackendSpawnInput> = {}): BackendSpawnInput {
	return {
		taskId: "oc-1",
		spec: {
			name: "unit",
			mode: "write",
			objective: "objective",
			relevantPaths: ["src"],
			constraints: [],
			expectedOutput: "",
		} satisfies TaskSpec,
		model: "opencode-go/glm-5.2",
		thinking: "high",
		prompt: "PROMPT",
		cwd: "/tmp/worktree",
		...overrides,
	};
}

function openCodeAdapter() {
	return new OpenCodeBackendAdapter({
		binary: "opencode",
		binaryArgs: [],
		defaultToolProfile: "coding",
		modelCapabilities: {},
	});
}

function agentDefinitionText(preparation: { agentName?: string; configDir?: string }): string {
	assert.ok(preparation.agentName);
	assert.ok(preparation.configDir);
	return readFileSync(path.join(preparation.configDir, "agent", `${preparation.agentName}.md`), "utf8");
}

test("OpenCodeBackendAdapter builds isolated --pure run args", () => {
	const adapter = new OpenCodeBackendAdapter({
		binary: "opencode",
		binaryArgs: ["--flag"],
		defaultToolProfile: "coding",
		modelCapabilities: {},
	});
	const input = spawnInput();
	assert.deepEqual(adapter.buildArgs(input, { agentName: "agent-x", activity: [] }), [
		"--flag", "run", "--pure", "--format", "json", "--model", input.model,
		"--variant", "high", "--agent", "agent-x", "PROMPT",
	]);
	assert.ok(!adapter.buildArgs(input, { activity: [] }).includes("--agent"));
});

test("OpenCode buildEnv discards ambient inline config and uses private config homes", () => {
	const adapter = openCodeAdapter();
	const input = spawnInput({ spec: { ...spawnInput().spec, role: "tester" } });
	const preparation = adapter.prepare(input);
	const base = {
		OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: "dark", mcp: { ambient: {} } }),
		XDG_DATA_HOME: "/private/data",
		CUSTOM: "1",
	};
	try {
		const env = adapter.buildEnv(base, input, preparation);
		assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT!), {
			permission: { edit: "deny", bash: { "*": "allow" } },
		});
		assert.equal(env.OPENCODE_CONFIG_DIR, preparation.configDir);
		assert.equal(env.XDG_CONFIG_HOME, preparation.runtimeDir);
		assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
		assert.equal(env.XDG_DATA_HOME, "/private/data");
		assert.equal(env.CUSTOM, "1");
		assert.equal(base.OPENCODE_CONFIG_CONTENT, JSON.stringify({ theme: "dark", mcp: { ambient: {} } }));
	} finally {
		adapter.cleanupAgent(preparation.agentName, preparation);
	}
});

test("OpenCode buildEnv removes ambient config entirely for an unroled worker", () => {
	const adapter = openCodeAdapter();
	const input = spawnInput();
	const preparation = adapter.prepare(input);
	try {
		const env = adapter.buildEnv({ OPENCODE_CONFIG_CONTENT: "not-json", XDG_CONFIG_HOME: "/ambient" }, input, preparation);
		assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined);
		assert.equal(env.XDG_CONFIG_HOME, preparation.runtimeDir);
		assert.equal(env.OPENCODE_CONFIG_DIR, preparation.configDir);
		assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
	} finally {
		adapter.cleanupAgent(preparation.agentName, preparation);
	}
});

test("OpenCode private agent definitions are scoped to the spawn and recursively cleaned", () => {
	const adapter = openCodeAdapter();
	const preparation = adapter.prepare(spawnInput());
	assert.ok(preparation.runtimeDir);
	assert.ok(preparation.configDir);
	assert.ok(preparation.configDir.startsWith(os.tmpdir()));
	assert.ok(!preparation.configDir.includes(path.join(os.homedir(), ".config")));
	assert.match(agentDefinitionText(preparation), /\*": deny/);
	const runtimeDir = preparation.runtimeDir;
	assert.equal(adapter.cleanupAgent(preparation.agentName, preparation), undefined);
	assert.equal(existsSync(runtimeDir), false);
	assert.doesNotThrow(() => adapter.cleanupAgent(undefined));
});

test("agent permissions are fail-closed and Executor is explicit", () => {
	const regular = agentFrontmatterFromTools(["read", "glob"]);
	assert.ok(regular.includes('permission:\n  "*": deny\n  read: allow\n  glob: allow'));
	assert.doesNotMatch(regular, /mcp\.executor/);
	assert.match(agentFrontmatterFromTools(TOOL_PROFILES.full), /skill: allow/);
	assert.ok(agentFrontmatterFromTools(["read"], true).includes('"mcp.executor.*": allow'));
	const config = JSON.parse(buildOpenCodeConfigContent("implementer", true, { PI_EXECUTOR_BIN: "custom-executor" })!);
	assert.deepEqual(config, {
		mcp: { executor: { type: "local", command: ["custom-executor", "mcp", "--elicitation-mode", "browser", "--no-artifacts", "--search-tools"] } },
	});
	assert.equal(buildOpenCodeConfigContent(undefined), undefined);
});

test("ambient config is never merged, including invalid JSON", () => {
	assert.deepEqual(JSON.parse(buildOpenCodeConfigContent("reviewer", false, { OPENCODE_CONFIG_CONTENT: "bad" })!), {
		permission: { edit: "deny", bash: "deny" },
	});
	assert.deepEqual(JSON.parse(buildOpenCodeConfigContent("tester", false, { OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: "dark" }) })!), {
		permission: { edit: "deny", bash: { "*": "allow" } },
	});
	assert.equal(buildOpenCodeConfigContent("implementer", false), undefined);
});

test("Executor gate is opt-in and fail-closed for non-implementer routes", () => {
	const input = { spec: { ...spawnInput().spec, executor: true, role: "implementer" as const }, model: "opencode-go/model" };
	assert.match(executorGateError(input, {}) ?? "", /PI_ORCH_ENABLE_EXECUTOR/);
	assert.match(executorGateError({ ...input, spec: { ...input.spec, role: undefined } }, { PI_ORCH_ENABLE_EXECUTOR: "1" }) ?? "", /explicit implementer/);
	assert.match(executorGateError({ ...input, model: "pi::provider/model" }, { PI_ORCH_ENABLE_EXECUTOR: "1" }) ?? "", /OpenCode backend/);
	assert.equal(executorGateError(input, { PI_ORCH_ENABLE_EXECUTOR: "1" }), undefined);
});

test("effective OpenCode tools preserve tester bash and deny excluded tools", () => {
	assert.deepEqual([...effectiveWorkerTools({ mode: "read_only", role: "tester" }, "coding")], ["bash", "read", "glob", "grep"]);
	assert.deepEqual([...effectiveWorkerTools({ mode: "write", role: "tester" }, "coding")], ["read", "glob", "grep", "edit", "bash"]);
	assert.deepEqual([...effectiveWorkerTools({ mode: "read_only", role: "reviewer" }, "coding")], ["read", "glob", "grep"]);
	const adapter = openCodeAdapter();
	const preparation = adapter.prepare(spawnInput({ spec: { ...spawnInput().spec, mode: "read_only", role: "tester" } }));
	try {
		const text = agentDefinitionText(preparation);
		assert.match(text, /bash: allow/);
		assert.doesNotMatch(text, /edit: allow/);
	} finally { adapter.cleanupAgent(preparation.agentName, preparation); }
});

test("Pi and Collie retain explicit backend boundaries", () => {
	const pi = new PiBackendAdapter({ binary: "pi", binaryArgs: ["--ext"] });
	const piInput = spawnInput({ model: "anthropic/claude", spec: { ...spawnInput().spec, mode: "read_only", role: "tester" } });
	assert.deepEqual(pi.buildArgs(piInput, { activity: [] }), ["--ext", "--approve", "--no-session", "--no-extensions", "--mode", "json", "--model", "anthropic/claude", "--thinking", "high", "--tools", "read,grep,find,ls,bash", "PROMPT"]);
	assert.equal(piToolList({ mode: "read_only", role: "reviewer" }), "read,grep,find,ls");
	assert.equal(piToolList({ mode: "write", role: undefined }), "read,grep,find,ls,bash,edit,write");
	const collie = new CollieBackendAdapter({ binary: "collie", binaryArgs: ["--wrapper"] });
	const collieInput = spawnInput({ model: "provider/model-name", spec: { ...spawnInput().spec, mode: "write", role: "implementer", worktree: true } });
	assert.deepEqual(collie.buildArgs(collieInput, { activity: [] }), ["--wrapper", "run", "PROMPT", "--provider", "provider", "--model", "model-name", "--cwd", "/tmp/worktree", "--mode", "auto", "--json", "--stream-json"]);
	assert.match(collieGateError({ spec: { ...collieInput.spec, mode: "read_only" } }, { PI_ORCH_ENABLE_COLLIE: "1" }) ?? "", /mode=write/);
	assert.match(collieGateError({ spec: collieInput.spec }, {}) ?? "", /disabled/);
});

test("shared output protocol helpers remain stable", () => {
	assert.equal(activityFromEvent({ type: "e", part: { type: "tool", tool: "read", state: { status: "completed" } } }), "read: completed");
	assert.equal(activityFromEvent({ type: "e", part: { type: "tool", tool: "read", state: { status: "running", input: { file: "src/a.ts" } } } }), "read: running src/a.ts");
	const pi = new PiBackendAdapter({ binary: "pi", binaryArgs: [] });
	const piStart = { type: "tool_execution_start", toolName: "read", args: { file: "src/a.ts" } };
	const piUpdate = { type: "tool_execution_update", toolName: "read", args: { file: "src/a.ts" } };
	const piEnd = { type: "tool_execution_end", toolName: "read", args: { file: "src/a.ts" }, isError: false };
	assert.equal(pi.decodeStdoutLine(JSON.stringify(piStart), piStart).activity[0], "read: running src/a.ts");
	assert.equal(pi.decodeStdoutLine(JSON.stringify(piUpdate), piUpdate).activity[0], "read: running src/a.ts");
	assert.equal(pi.decodeStdoutLine(JSON.stringify(piEnd), piEnd).activity[0], "read: completed src/a.ts");
	const piError = { ...piEnd, isError: true };
	assert.equal(pi.decodeStdoutLine(JSON.stringify(piError), piError).activity[0], "read: error src/a.ts");
	const collie = new CollieBackendAdapter({ binary: "collie" });
	assert.deepEqual(collie.decodeStderrChunk(JSON.stringify({ type: "progress", message: "streaming" })).activity, ["progress: streaming"]);
	assert.deepEqual(collie.decodeStderrChunk(JSON.stringify({ type: "progress", status: "streaming" })).activity, ["progress: streaming"]);
	assert.deepEqual(collie.decodeStderrChunk(JSON.stringify({ type: "Collie free-form reasoning", message: "streaming" })).activity, []);
	assert.deepEqual(collie.decodeStderrChunk(JSON.stringify({ type: "progress", message: "run rm -rf /tmp/x" })).activity, []);
	assert.deepEqual(collie.decodeStderrChunk(JSON.stringify({ type: "progress", message: "hidden reasoning" })).activity, []);
	assert.deepEqual(collie.decodeStderrChunk(JSON.stringify({ activity: "hidden reasoning" })).activity, []);
	assert.equal(activityFromEvent({ type: "e", part: { type: "step-finish", reason: "stop" } }), "step finished: stop");
	assert.deepEqual(openCodeAdapter().decodeStdoutLine("plain", undefined), { output: "plain\n", activity: [] });
	const report: WorkerReport = { summary: "s", files: [], findings: [], unresolved: [] };
	const adapters: WorkerBackendAdapter[] = [openCodeAdapter(), new PiBackendAdapter({ binary: "pi", binaryArgs: [] })];
	for (const adapter of adapters) {
		assert.deepEqual(adapter.decodeStderrChunk("raw\n"), { text: "raw\n", activity: [] });
		assert.deepEqual(adapter.normalizeExitReport(report), report);
	}
});
