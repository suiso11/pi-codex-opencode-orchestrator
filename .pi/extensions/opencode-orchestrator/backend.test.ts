import assert from "node:assert/strict";
import test from "node:test";
import type { BackendSpawnInput } from "./backends/backend.ts";
import { buildOpenCodeConfigContent, OpenCodeBackendAdapter } from "./backends/opencode.ts";
import { PiBackendAdapter, piToolList } from "./backends/pi.ts";
import type { TaskSpec } from "./types.ts";

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
