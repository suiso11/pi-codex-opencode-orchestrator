import assert from "node:assert/strict";
import test from "node:test";
import { activityFromEvent, type BackendSpawnInput, type WorkerBackendAdapter } from "./backends/backend.ts";
import { buildOpenCodeConfigContent, OpenCodeBackendAdapter } from "./backends/opencode.ts";
import { PiBackendAdapter, piToolList } from "./backends/pi.ts";
import { CollieBackendAdapter, collieGateError } from "./backends/collie.ts";
import { executorGateError } from "./backends/opencode.ts";
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

test("OpenCodeBackendAdapter builds the legacy run args with agent and variant", () => {
	const adapter = new OpenCodeBackendAdapter({
		binary: "opencode",
		binaryArgs: ["--flag"],
		defaultToolProfile: "coding",
		modelCapabilities: {},
	});
	const input = spawnInput();
	const args = adapter.buildArgs(input, { agentName: "agent-x", activity: [] });
	assert.deepEqual(args, [
		"--flag",
		"run",
		"--format",
		"json",
		"--model",
		"opencode-go/glm-5.2",
		"--variant",
		"high",
		"--agent",
		"agent-x",
		"PROMPT",
	]);
});

test("OpenCodeBackendAdapter omits --agent when no agent name was prepared", () => {
	const adapter = new OpenCodeBackendAdapter({
		binary: "opencode",
		binaryArgs: [],
		defaultToolProfile: "coding",
		modelCapabilities: {},
	});
	const args = adapter.buildArgs(spawnInput(), { activity: [] });
	assert.ok(!args.includes("--agent"));
	assert.equal(args.at(-1), "PROMPT");
});

test("OpenCodeBackendAdapter buildEnv merges role permission override and preserves other keys", () => {
	const adapter = new OpenCodeBackendAdapter({
		binary: "opencode",
		binaryArgs: [],
		defaultToolProfile: "coding",
		modelCapabilities: {},
	});
	const base = { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: "dark" }), CUSTOM: "1" };
	const merged = adapter.buildEnv(base, spawnInput({ spec: { ...spawnInput().spec, role: "tester" } }));
	const parsed = JSON.parse(merged.OPENCODE_CONFIG_CONTENT!);
	assert.equal(parsed.theme, "dark");
	assert.equal(parsed.permission.edit, "deny");
	assert.equal(parsed.permission.bash["*"], "allow");
	assert.equal(merged.CUSTOM, "1");
	assert.equal(merged.NO_COLOR, process.env.NO_COLOR);
});

test("OpenCodeBackendAdapter buildEnv leaves env untouched without a role override", () => {
	const adapter = new OpenCodeBackendAdapter({
		binary: "opencode",
		binaryArgs: [],
		defaultToolProfile: "coding",
		modelCapabilities: {},
	});
	const base = { A: "1", OPENCODE_CONFIG_CONTENT: "{}" };
	const env = adapter.buildEnv(base, spawnInput());
	assert.equal(env, base);
	assert.equal(env.OPENCODE_CONFIG_CONTENT, "{}");
});

test("OpenCodeBackendAdapter cleanupAgent tolerates missing and undefined agent names", () => {
	const adapter = new OpenCodeBackendAdapter({
		binary: "opencode",
		binaryArgs: [],
		defaultToolProfile: "coding",
		modelCapabilities: {},
	});
	assert.doesNotThrow(() => adapter.cleanupAgent(undefined));
	assert.doesNotThrow(() => adapter.cleanupAgent("pi-orch-does-not-exist"));
});

test("Executor MCP config overrides only mcp.executor with fixed browser approval", () => {
	const existing = JSON.stringify({ theme: "dark", mcp: { other: { type: "remote" }, executor: { type: "remote" } } });
	const merged = JSON.parse(buildOpenCodeConfigContent("implementer", existing, true, { PI_EXECUTOR_BIN: "custom-executor" })!);
	assert.equal(merged.theme, "dark");
	assert.deepEqual(merged.mcp.other, { type: "remote" });
	assert.deepEqual(merged.mcp.executor, {
		type: "local",
		command: ["custom-executor", "mcp", "--elicitation-mode", "browser", "--no-artifacts", "--search-tools"],
	});
});

test("Executor gate is opt-in and fail-closed for non-implementer routes", () => {
	const input = { spec: { ...spawnInput().spec, executor: true, role: "implementer" as const }, model: "opencode-go/model" };
	assert.match(executorGateError(input, {}) ?? "", /PI_ORCH_ENABLE_EXECUTOR/);
	assert.match(executorGateError({ ...input, spec: { ...input.spec, role: undefined } }, { PI_ORCH_ENABLE_EXECUTOR: "1" }) ?? "", /explicit implementer/);
	assert.match(executorGateError({ ...input, model: "pi::provider/model" }, { PI_ORCH_ENABLE_EXECUTOR: "1" }) ?? "", /OpenCode backend/);
	assert.equal(executorGateError(input, { PI_ORCH_ENABLE_EXECUTOR: "1" }), undefined);
});

test("buildOpenCodeConfigContent keeps invalid inline JSON out of the merged config", () => {
	const tester = JSON.parse(buildOpenCodeConfigContent("tester", "not-json")!);
	assert.deepEqual(tester, { permission: { edit: "deny", bash: { "*": "allow" } } });
	assert.equal(buildOpenCodeConfigContent(undefined, undefined), undefined);
});

test("PiBackendAdapter builds the legacy json-mode args with an explicit tool list", () => {
	const adapter = new PiBackendAdapter({ binary: "pi", binaryArgs: ["--ext"] });
	const spec: TaskSpec = { ...spawnInput().spec, mode: "read_only", role: "tester" };
	const args = adapter.buildArgs(spawnInput({ spec, model: "anthropic/claude-example" }), { activity: [] });
	assert.deepEqual(args, [
		"--ext",
		"--approve",
		"--no-session",
		"--no-extensions",
		"--mode",
		"json",
		"--model",
		"anthropic/claude-example",
		"--thinking",
		"high",
		"--tools",
		"read,grep,find,ls,bash",
		"PROMPT",
	]);
});

test("PiBackendAdapter buildEnv passes the environment through and cleanupAgent is a no-op", () => {
	const adapter = new PiBackendAdapter({ binary: "pi", binaryArgs: [] });
	const base = { A: "1" };
	assert.equal(adapter.buildEnv(base, spawnInput()), base);
	assert.doesNotThrow(() => adapter.cleanupAgent(undefined));
	assert.doesNotThrow(() => adapter.cleanupAgent("whatever"));
	const preparation = adapter.prepare(spawnInput());
	assert.deepEqual(preparation, { activity: [] });
});

test("piToolList preserves the exact per-role Pi tool allowlists", () => {
	const base: TaskSpec = spawnInput().spec;
	assert.equal(piToolList({ mode: "write", role: "reviewer" }), "read,grep,find,ls");
	assert.equal(piToolList({ mode: "read_only", role: "reviewer" }), "read,grep,find,ls");
	assert.equal(piToolList({ mode: "read_only", role: "tester" }), "read,grep,find,ls,bash");
	assert.equal(piToolList({ mode: "read_only", role: undefined }), "read,grep,find,ls");
	assert.equal(piToolList({ mode: "write", role: undefined }), "read,grep,find,ls,bash,edit,write");
	assert.equal(piToolList({ mode: "write", role: "implementer" }), "read,grep,find,ls,bash,edit,write");
});

// Output protocol contract: the manager only applies the decoded result of
// these methods to bounded snapshot storage; each adapter must preserve its
// backend's exact raw-output text and activity decoding.
function openCodeAdapter() {
	return new OpenCodeBackendAdapter({
		binary: "opencode",
		binaryArgs: [],
		defaultToolProfile: "coding",
		modelCapabilities: {},
	});
}

test("activityFromEvent decodes tool, step-finish, and fallback labels", () => {
	assert.equal(activityFromEvent({ type: "e", part: { type: "tool", tool: "read", state: { status: "completed" } } }), "read: completed");
	assert.equal(activityFromEvent({ type: "e", part: { type: "tool", tool: "bash", state: {} } }), "bash: update");
	assert.equal(activityFromEvent({ type: "e", part: { type: "step-finish", reason: "stop" } }), "step finished: stop");
	assert.equal(activityFromEvent({ type: "message_end" }), "message_end");
	assert.equal(activityFromEvent({ part: { type: "other" } }), "event: other");
});

test("OpenCodeBackendAdapter decodes text streaming events into output and activity", () => {
	const adapter = openCodeAdapter();
	const event = { type: "text", part: { type: "text", text: "hello" } };
	const decoded = adapter.decodeStdoutLine(JSON.stringify(event), event);
	assert.equal(decoded.output, "hello\n");
	assert.deepEqual(decoded.activity, ["text: text"]);
});

test("OpenCodeBackendAdapter retains non-JSON stdout lines verbatim without activity", () => {
	const adapter = openCodeAdapter();
	const decoded = adapter.decodeStdoutLine("plain diagnostic line", undefined);
	assert.equal(decoded.output, "plain diagnostic line\n");
	assert.deepEqual(decoded.activity, []);
});

test("OpenCodeBackendAdapter emits activity only for structured non-text events", () => {
	const adapter = openCodeAdapter();
	const event = { type: "step_finish", part: { type: "step-finish", reason: "stop" } };
	const decoded = adapter.decodeStdoutLine(JSON.stringify(event), event);
	assert.equal(decoded.output, undefined);
	assert.deepEqual(decoded.activity, ["step finished: stop"]);
});

test("PiBackendAdapter decodes message_end text content and labels other events", () => {
	const adapter = new PiBackendAdapter({ binary: "pi", binaryArgs: [] });
	const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } };
	const decoded = adapter.decodeStdoutLine(JSON.stringify(event), event);
	assert.equal(decoded.output, "a\nb\n");
	assert.deepEqual(decoded.activity, ["message_end"]);
	const other = adapter.decodeStdoutLine("{}", { type: "message_update" });
	assert.equal(other.output, undefined);
	assert.deepEqual(other.activity, ["message_update"]);
});

test("PiBackendAdapter marks non-JSON stdout lines as Pi response streaming", () => {
	const adapter = new PiBackendAdapter({ binary: "pi", binaryArgs: [] });
	const decoded = adapter.decodeStdoutLine("pi diagnostic line", undefined);
	assert.equal(decoded.output, "pi diagnostic line\n");
	assert.deepEqual(decoded.activity, ["Pi response streaming"]);
});

test("output protocol decodes stderr chunks unchanged and normalizes exit reports to identity", () => {
	const adapters: WorkerBackendAdapter[] = [
		openCodeAdapter(),
		new PiBackendAdapter({ binary: "pi", binaryArgs: [] }),
	];
	const report: WorkerReport = { summary: "s", files: ["f"], findings: ["x"], unresolved: ["y"] };
	for (const adapter of adapters) {
		assert.deepEqual(adapter.decodeStderrChunk("raw chunk\n"), { text: "raw chunk\n", activity: [] });
		assert.deepEqual(adapter.normalizeExitReport(report), report);
	}
});

test("CollieBackendAdapter is fail-closed and builds the exact isolated command", () => {
	const adapter = new CollieBackendAdapter({ binary: "collie", binaryArgs: ["--wrapper"] });
	const input = spawnInput({
		model: "provider/model-name",
		spec: { ...spawnInput().spec, mode: "write", role: "implementer", worktree: true },
	});
	assert.deepEqual(adapter.buildArgs(input, { activity: [] }), [
		"--wrapper", "run", "PROMPT", "--provider", "provider", "--model", "model-name",
		"--cwd", "/tmp/worktree", "--mode", "auto", "--json", "--stream-json",
	]);
	assert.deepEqual(adapter.decodeStdoutLine("", { answer: JSON.stringify({ summary: "ok", files: [], findings: [], unresolved: [] }), usage: { input: 1 } }).activity, ["event"]);
	assert.match(adapter.decodeStdoutLine("", { answer: "plain answer" }).output ?? "", /plain answer/);
	assert.deepEqual(adapter.decodeStderrChunk(JSON.stringify({ type: "progress", message: "working" }) + "\n").activity, ["progress: working"]);
	assert.match(collieGateError({ spec: { ...input.spec, mode: "read_only" } }, { PI_ORCH_ENABLE_COLLIE: "1" }) ?? "", /mode=write/);
	assert.match(collieGateError({ spec: input.spec }, {}) ?? "", /disabled/);
});

test("CollieBackendAdapter normalizes stdout reports and stderr NDJSON diagnostics", () => {
	const adapter = new CollieBackendAdapter({ binary: "collie", binaryArgs: [] });
	// Non-JSON stdout lines append nothing (Collie stdout is final-JSON only).
	assert.deepEqual(adapter.decodeStdoutLine("plain line", undefined), { output: undefined, activity: [] });
	// Plain string answers are wrapped into the common report shape.
	assert.equal(
		adapter.decodeStdoutLine("", { answer: "done quickly" }).output,
		`${JSON.stringify({ summary: "done quickly", files: [], findings: [], unresolved: [] })}\n`,
	);
	// Error strings become unresolved findings in the normalized report.
	assert.equal(
		adapter.decodeStdoutLine("", { error: "boom" }).output,
		`${JSON.stringify({ summary: "Collie worker error", files: [], findings: [], unresolved: ["boom"] })}\n`,
	);
	// Stderr NDJSON: activity strings, part-based tool labels, and status
	// fields decode to labels; non-JSON lines add no activity while raw text
	// is always retained verbatim.
	assert.deepEqual(adapter.decodeStderrChunk(JSON.stringify({ activity: "hand-running" }) + "\n").activity, ["hand-running"]);
	assert.deepEqual(
		adapter.decodeStderrChunk(JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "edit", state: { status: "done" } } }) + "\n").activity,
		["edit: done"],
	);
	assert.deepEqual(adapter.decodeStderrChunk(JSON.stringify({ type: "state", status: "starting" }) + "\n").activity, ["state: starting"]);
	const raw = adapter.decodeStderrChunk("not json\n");
	assert.equal(raw.text, "not json\n");
	assert.deepEqual(raw.activity, []);
});
