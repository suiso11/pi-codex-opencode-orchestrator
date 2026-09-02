import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import extension, {
	activateToolGroup,
	boundParentText,
	coordinatorAllowlist,
	coordinatorContractText,
	describeWorktreeMutationOutcome,
	formatBatchDeliverable,
	formatRawOutputSlice,
	formatRetainedWorktreeDetail,
	formatRetainedWorktreeList,
	handleWorktreeCommand,
	isCoordinatorAllowedTool,
	shouldDelayBackgroundDelivery,
	toTaskSpec,
} from "./index.ts";
import { buildWorkerPrompt, taskSummary } from "./types.ts";
import type { TaskSnapshot, WorkflowSnapshot, RetainedWorktreeView } from "./types.ts";
import type { RetainedWorktreeManagerLike } from "./index.ts";

interface RegisteredTool {
	name: string;
	parameters: unknown;
	execute: (...args: unknown[]) => Promise<unknown>;
}

interface RegisteredCommand {
	handler: (args: string, ctx: unknown) => Promise<unknown>;
}

function activateExtension() {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, RegisteredCommand>();
	const listeners = new Map<string, ((...args: unknown[]) => unknown)[]>();
	// Mutable active-tool state so session_start/before_agent_start re-application
	// and opencode_tools group activation can be asserted.
	const active: string[] = [];
	const pi = {
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, def: RegisteredCommand) {
			commands.set(name, def);
		},
		on(event: string, listener: (...args: unknown[]) => unknown) {
			const group = listeners.get(event) ?? [];
			group.push(listener);
			listeners.set(event, group);
		},
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active.splice(0, active.length, ...names);
		},
		sendMessage: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true,
	};
	extension(pi as unknown as Parameters<typeof extension>[0]);
	return { tools, commands, listeners, active };
}

/** Invoke every listener for an event, returning the last non-undefined result. */
async function emit(
	listeners: Map<string, ((...args: unknown[]) => unknown)[]>,
	event: string,
	...args: unknown[]
): Promise<unknown> {
	const list = listeners.get(event) ?? [];
	let last: unknown;
	for (const listener of list) {
		const result = await listener(...args);
		if (result !== undefined) last = result;
	}
	return last;
}

/** Narrow return type for `tool_call` block results. */
interface ToolCallBlockResult {
	block: boolean;
	reason: string;
}

/** Narrow return type for `user_bash` cancel results. */
interface BashCancelResult {
	result: {
		output: string;
		exitCode: number;
		cancelled: boolean;
		truncated: boolean;
	};
}

/** Narrow return type for `before_agent_start` prompt-injection results. */
interface BeforeAgentStartResult {
	systemPrompt: string;
}

async function emitToolCall(
	listeners: Map<string, ((...args: unknown[]) => unknown)[]>,
	...args: unknown[]
): Promise<ToolCallBlockResult | undefined> {
	return (await emit(listeners, "tool_call", ...args)) as ToolCallBlockResult | undefined;
}

async function emitUserBash(
	listeners: Map<string, ((...args: unknown[]) => unknown)[]>,
	...args: unknown[]
): Promise<BashCancelResult | undefined> {
	return (await emit(listeners, "user_bash", ...args)) as BashCancelResult | undefined;
}

async function emitBeforeAgentStart(
	listeners: Map<string, ((...args: unknown[]) => unknown)[]>,
	...args: unknown[]
): Promise<BeforeAgentStartResult | undefined> {
	return (await emit(listeners, "before_agent_start", ...args)) as BeforeAgentStartResult | undefined;
}

function taskPayload(overrides: Record<string, unknown> = {}) {
	return {
		name: "verify-role",
		mode: "read_only",
		objective: "Verify role routing",
		relevant_paths: ["src"],
		expected_output: "result",
		...overrides,
	};
}

const ALL_ROLES = ["implementer", "tester", "reviewer"] as const;

test("registered spawn and task tools accept implementer, tester, and reviewer roles", () => {
	const { tools } = activateExtension();
	for (const toolName of ["opencode_spawn", "opencode_task"]) {
		const schema = tools.get(toolName)?.parameters;
		assert.ok(schema, `${toolName} not registered`);
		for (const role of ALL_ROLES) {
			assert.equal(Value.Check(schema, taskPayload({ role })), true, `${toolName} rejected role ${role}`);
		}
		assert.equal(Value.Check(schema, taskPayload()), true, `${toolName} rejected a role-less task`);
	}
});

test("registered workflow tool accepts roles on tasks in every phase", () => {
	const { tools } = activateExtension();
	const schema = tools.get("opencode_workflow")?.parameters;
	assert.ok(schema, "opencode_workflow not registered");
	for (const role of ALL_ROLES) {
		const workflow = {
			name: "role-workflow",
			phases: [
				{ name: "one", tasks: [taskPayload({ role })] },
				{ name: "two", tasks: [taskPayload({ role: "reviewer" })] },
			],
		};
		assert.equal(Value.Check(schema, workflow), true, `workflow rejected role ${role}`);
	}
});

test("registered schemas reject invalid role, profile, and thinking values", () => {
	const { tools } = activateExtension();
	for (const toolName of ["opencode_spawn", "opencode_task"]) {
		const schema = tools.get(toolName)?.parameters;
		assert.ok(schema, `${toolName} not registered`);
		assert.equal(Value.Check(schema, taskPayload({ role: "architect" })), false, `${toolName} accepted invalid role`);
		assert.equal(Value.Check(schema, taskPayload({ profile: "auditor" })), false, `${toolName} accepted invalid profile`);
		assert.equal(Value.Check(schema, taskPayload({ thinking: "turbo" })), false, `${toolName} accepted invalid thinking`);
	}
	const workflowSchema = tools.get("opencode_workflow")?.parameters;
	assert.ok(workflowSchema, "opencode_workflow not registered");
	assert.equal(
		Value.Check(workflowSchema, {
			name: "bad-role-workflow",
			phases: [
				{ name: "one", tasks: [taskPayload({ role: "architect" })] },
				{ name: "two", tasks: [taskPayload()] },
			],
		}),
		false,
		"workflow accepted an invalid role",
	);
});

test("registered schemas accept boolean worktree and reject non-boolean values", () => {
	const { tools } = activateExtension();
	for (const toolName of ["opencode_spawn", "opencode_task"]) {
		const schema = tools.get(toolName)?.parameters;
		assert.ok(schema, `${toolName} not registered`);
		assert.equal(Value.Check(schema, taskPayload({ worktree: true })), true, `${toolName} rejected worktree: true`);
		assert.equal(Value.Check(schema, taskPayload({ worktree: false })), true, `${toolName} rejected worktree: false`);
		assert.equal(Value.Check(schema, taskPayload({ worktree: "yes" })), false, `${toolName} accepted string worktree`);
		assert.equal(Value.Check(schema, taskPayload({ worktree: 1 })), false, `${toolName} accepted numeric worktree`);
	}
	const workflowSchema = tools.get("opencode_workflow")?.parameters;
	assert.ok(workflowSchema, "opencode_workflow not registered");
	const workflow = (worktree: unknown) => ({
		name: "worktree-workflow",
		phases: [
			{ name: "one", tasks: [taskPayload({ mode: "write", worktree })] },
			{ name: "two", tasks: [taskPayload()] },
		],
	});
	assert.equal(Value.Check(workflowSchema, workflow(true)), true, "workflow rejected worktree: true");
	assert.equal(Value.Check(workflowSchema, workflow(false)), true, "workflow rejected worktree: false");
	assert.equal(Value.Check(workflowSchema, workflow("yes")), false, "workflow accepted string worktree");
});

test("registered spawn schema round-trips worktree into toTaskSpec", () => {
	const { tools } = activateExtension();
	const schema = tools.get("opencode_spawn")?.parameters;
	assert.ok(schema, "opencode_spawn not registered");
	const payload = taskPayload({ mode: "write", worktree: true });
	assert.equal(Value.Check(schema, payload), true, "spawn schema rejected a valid worktree task");
	const spec = toTaskSpec(payload as Parameters<typeof toTaskSpec>[0]);
	assert.equal(spec.worktree, true);
});

test("registered schemas accept boolean executor and reject non-boolean values", () => {
	const { tools } = activateExtension();
	for (const toolName of ["opencode_spawn", "opencode_task"]) {
		const schema = tools.get(toolName)?.parameters;
		assert.ok(schema, `${toolName} not registered`);
		assert.equal(Value.Check(schema, taskPayload({ executor: true })), true, `${toolName} rejected executor: true`);
		assert.equal(Value.Check(schema, taskPayload({ executor: false })), true, `${toolName} rejected executor: false`);
		assert.equal(Value.Check(schema, taskPayload({ executor: "yes" })), false, `${toolName} accepted string executor`);
		assert.equal(Value.Check(schema, taskPayload({ executor: 1 })), false, `${toolName} accepted numeric executor`);
	}
	const workflowSchema = tools.get("opencode_workflow")?.parameters;
	assert.ok(workflowSchema, "opencode_workflow not registered");
	const workflow = (executor: unknown) => ({
		name: "executor-workflow",
		phases: [
			{ name: "one", tasks: [taskPayload({ role: "implementer", executor })] },
			{ name: "two", tasks: [taskPayload()] },
		],
	});
	assert.equal(Value.Check(workflowSchema, workflow(true)), true, "workflow rejected executor: true");
	assert.equal(Value.Check(workflowSchema, workflow(false)), true, "workflow rejected executor: false");
	assert.equal(Value.Check(workflowSchema, workflow("yes")), false, "workflow accepted string executor");
});

test("registered task and workflow schemas round-trip executor into toTaskSpec", () => {
	const { tools } = activateExtension();
	const executorTask = taskPayload({ role: "implementer", executor: true });
	const plainTask = taskPayload();
	for (const toolName of ["opencode_spawn", "opencode_task"]) {
		const schema = tools.get(toolName)?.parameters;
		assert.ok(schema, `${toolName} not registered`);
		assert.equal(Value.Check(schema, executorTask), true, `${toolName} rejected a valid executor task`);
		const spec = toTaskSpec(executorTask as unknown as Parameters<typeof toTaskSpec>[0]);
		assert.equal(spec.executor, true, `${toolName} dropped executor during conversion`);
	}
	const workflowSchema = tools.get("opencode_workflow")?.parameters;
	assert.ok(workflowSchema, "opencode_workflow not registered");
	const workflow = {
		name: "executor-workflow",
		phases: [
			{ name: "one", tasks: [executorTask] },
			{ name: "two", tasks: [plainTask] },
		],
	};
	assert.equal(Value.Check(workflowSchema, workflow), true, "workflow rejected a valid executor task");
	const phaseTasks = workflow.phases.flatMap((phase) => phase.tasks);
	const workflowSpecs = phaseTasks.map((raw) => toTaskSpec(raw as unknown as Parameters<typeof toTaskSpec>[0]));
	assert.equal(workflowSpecs[0].executor, true, "workflow dropped executor during conversion");
	assert.equal(workflowSpecs[1].executor, undefined, "workflow invented executor for a plain task");
});

test("toTaskSpec forwards executor and omits it for bare tasks", () => {
	const spec = toTaskSpec({
		name: "executor-task",
		mode: "write",
		objective: "Implement with executor",
		relevant_paths: ["src"],
		expected_output: "result",
		role: "implementer",
		executor: true,
	});
	assert.equal(spec.executor, true);

	const bare = toTaskSpec({
		name: "bare",
		mode: "read_only",
		objective: "Bare",
		relevant_paths: ["src"],
		expected_output: "result",
	});
	assert.equal(bare.executor, undefined);
});

test("worktree state surfaces in status text and details without leaking into worker prompts", () => {
	const snapshot = task({
		worktree: { isolated: true, baseHead: "abc1234", status: "pending", changedPaths: [] },
	});
	// Status text (taskSummary) shows the isolation state.
	assert.match(taskSummary(snapshot), /\[worktree:pending\]/);
	// The public details source (snapshot.worktree) never carries the worktree path.
	assert.equal("path" in (snapshot.worktree ?? {}), false, "worktree path must not appear in public details");

	const spec = toTaskSpec({
		name: "implement",
		mode: "write",
		objective: "Implement",
		relevant_paths: ["src"],
		expected_output: "result",
		worktree: true,
	});
	const prompt = buildWorkerPrompt(spec);
	assert.match(prompt, /isolated Git worktree/);
	assert.doesNotMatch(prompt, /oc-worktrees/, "worktree temp root must not leak into the prompt");
	assert.doesNotMatch(prompt, /abc1234/, "worktree base head must not leak into the prompt");
});

test("toTaskSpec forwards role, profile, thinking, and worktree into TaskSpec", () => {
	const spec = toTaskSpec({
		name: "verify",
		mode: "read_only",
		objective: "Verify",
		relevant_paths: ["src", "tests"],
		expected_output: "result",
		role: "tester",
		profile: "implementer",
		thinking: "low",
		worktree: true,
	});
	assert.equal(spec.role, "tester");
	assert.equal(spec.profile, "implementer");
	assert.equal(spec.thinking, "low");
	assert.equal(spec.worktree, true);
	assert.deepEqual(spec.relevantPaths, ["src", "tests"]);
	assert.deepEqual(spec.constraints, []);
	assert.equal(spec.expectedOutput, "result");

	const bare = toTaskSpec({
		name: "bare",
		mode: "read_only",
		objective: "Bare",
		relevant_paths: ["src"],
		expected_output: "result",
	});
	assert.equal(bare.role, undefined);
	assert.equal(bare.profile, undefined);
	assert.equal(bare.thinking, undefined);
	assert.equal(bare.worktree, undefined);
});

test("opencode-status surfaces the configured tester profile and worker thinking", async () => {
	const original = process.env.PI_OPENCODE_PROFILE_TESTER;
	process.env.PI_OPENCODE_PROFILE_TESTER = "custom/tester-model";
	try {
		const { commands } = activateExtension();
		const handler = commands.get("opencode-status")?.handler;
		assert.ok(handler, "opencode-status not registered");
		const notified: string[] = [];
		await handler("", { ui: { notify: (message: string) => notified.push(message) } });
		const text = notified[0] ?? "";
		assert.match(text, /Tester profile: custom\/tester-model/);
		assert.match(text, /Worker thinking: (low|medium|high)/);
		assert.match(text, /Profiles: implementer=/);
	} finally {
		if (original === undefined) delete process.env.PI_OPENCODE_PROFILE_TESTER;
		else process.env.PI_OPENCODE_PROFILE_TESTER = original;
	}
});

function task(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
	return {
		id: "oc-1", name: "task", mode: "read_only", status: "done", objective: "test",
		relevantPaths: ["README.md"], scopes: [], model: "model", backend: "opencode",
		createdAt: 0, settledAt: 1, output: "", stderr: "", activity: [], timedOut: false,
		truncated: false, report: { summary: "x".repeat(2_000), files: [], findings: [], unresolved: [] },
		...overrides,
	};
}

function workflow(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
	return {
		id: "ow-1", name: "workflow", status: "done", phases: [
			{ name: "one", tasks: [] }, { name: "two", tasks: [] },
		], taskIds: [], createdAt: 0, settledAt: 1, ...overrides,
	};
}

test("formatBatchDeliverable stays within one 8000-character parent message", () => {
	const tasks = Array.from({ length: 8 }, (_, index) => task({ id: `oc-${index + 1}` }));
	const text = formatBatchDeliverable(tasks, [workflow()], () => "w".repeat(9_000));
	assert.ok(text.length <= 8_000, `length=${text.length}`);
	assert.match(text, /Batch delivery truncated/);
});

test("formatRawOutputSlice enforces total limits and clamps offsets", () => {
	const output = "0123456789".repeat(2_000);
	for (const limit of [1, 40, 8_000, 12_000, 20_000]) {
		const result = formatRawOutputSlice(output, 10, limit);
		assert.ok(result.text.length <= Math.min(Math.max(1, limit), 12_000));
		assert.equal(result.offset, 10);
		assert.ok(result.end >= result.offset && result.end <= output.length);
	}
	const beyond = formatRawOutputSlice(output, output.length + 999, 100);
	assert.equal(beyond.offset, output.length);
	assert.equal(beyond.end, output.length);
});

test("background batching waits for all standalone tasks and workflows", () => {
	assert.equal(shouldDelayBackgroundDelivery([task({ status: "running" })], []), true);
	assert.equal(shouldDelayBackgroundDelivery([task({ status: "running", workflowId: "ow-1" })], []), false);
	assert.equal(shouldDelayBackgroundDelivery([task({ status: "done" })], [workflow({ status: "running" })]), true);
	assert.equal(shouldDelayBackgroundDelivery([task({ status: "done" })], [workflow()]), false);
});

test("boundParentText caps arbitrary normal tool content at 8000", () => {
	const text = boundParentText("x".repeat(20_000));
	assert.ok(text.length <= 8_000);
	assert.match(text, /Parent-facing output truncated/);
});

test("coordinator allowlist keeps core tools always active and optional tools only when already active", () => {
	const active = coordinatorAllowlist(["read", "subagent", "bash", "edit", "apply_patch", "patch", "opencode_output", "opencode_workflow"]);
	for (const safe of ["read", "grep", "find", "ls"]) {
		assert.ok(active.includes(safe), `missing safe read ${safe}`);
	}
	for (const core of ["opencode_task", "opencode_spawn", "opencode_wait", "opencode_tools"]) {
		assert.ok(active.includes(core), `missing core tool ${core}`);
	}
	// Optional tools already active in the current set are preserved.
	assert.ok(active.includes("opencode_output"));
	assert.ok(active.includes("opencode_workflow"));
	for (const banned of ["subagent", "bash", "edit", "write", "apply_patch", "patch"]) {
		assert.ok(!active.includes(banned), `${banned} must be dropped`);
	}
	// Optional tools not currently active are NOT auto-activated (lazy loading).
	const lazy = coordinatorAllowlist(["read", "bash"]);
	for (const optional of ["opencode_check", "opencode_output", "opencode_workflow", "opencode_verified_task"]) {
		assert.ok(!lazy.includes(optional), `${optional} must not be auto-activated`);
	}
	assert.equal(isCoordinatorAllowedTool("read"), true);
	assert.equal(isCoordinatorAllowedTool("opencode_spawn"), true);
	assert.equal(isCoordinatorAllowedTool("bash"), false);
	assert.equal(isCoordinatorAllowedTool("apply_patch"), false);
});

test("coordinator allowlist uses an exact tool-name set and drops unknown opencode_* tools", () => {
	// Unknown opencode_* names (e.g. from another extension) never survive the
	// allowlist even when currently active.
	const active = coordinatorAllowlist(["read", "opencode_evil", "opencode_bypass", "opencode_verified_task"]);
	assert.ok(active.includes("opencode_verified_task"), "known optional tool must be preserved when active");
	for (const unknown of ["opencode_evil", "opencode_bypass"]) {
		assert.ok(!active.includes(unknown), `${unknown} must be dropped from the allowlist`);
	}
	// Core tools are always present; unknown names are never auto-added.
	assert.ok(active.includes("opencode_tools"));
	assert.ok(!coordinatorAllowlist(["read", "bash", "opencode_malicious"]).includes("opencode_malicious"));
});

test("coordinator gate blocks unknown opencode_* tools and allows every registered orchestration tool", async () => {
	// Gate: every registered core/optional orchestration tool is allowed by name,
	// including tools not yet dynamically activated (active tool determination
	// stays with Pi).
	const { tools, listeners } = activateExtension();
	for (const name of Object.keys(tools)) {
		assert.equal(isCoordinatorAllowedTool(name), true, `${name} must pass the coordinator gate`);
		const result = await emitToolCall(listeners, { toolCallId: "id", toolName: name, input: {} });
		assert.equal(result, undefined, `${name} should be allowed (no block)`);
	}
	assert.equal(isCoordinatorAllowedTool("opencode_verified_task"), true);
	// Unknown opencode_* names from other extensions are blocked by the gate.
	for (const name of ["opencode_evil", "opencode_unrelated", "opencode_shell"]) {
		assert.equal(isCoordinatorAllowedTool(name), false, `${name} must not pass the gate`);
		const block = await emitToolCall(listeners, { toolCallId: "id", toolName: name, input: {} });
		assert.ok(block, `${name} should be blocked`);
		assert.equal(block.block, true);
		assert.match(block.reason, /Coordinator-only parent/);
	}
});

test("session_start replaces active tools with safe reads plus active opencode tools", async () => {
	const original = process.env.LOCALAPPDATA;
	const tempDir = join(tmpdir(), "pi-orch-test-session");
	process.env.LOCALAPPDATA = tempDir;
	const { listeners, active } = activateExtension();
	try {
		active.push("read", "bash", "edit", "write", "subagent", "opencode_output", "opencode_workflow");
		const ctx = {
			hasUI: false,
			isIdle: () => true,
			model: undefined,
			modelRegistry: { refresh: async () => {}, find: () => undefined },
			ui: { notify: () => {} },
		};
		await emit(listeners, "session_start", {}, ctx);
		for (const safe of ["read", "grep", "find", "ls"]) {
			assert.ok(active.includes(safe), `missing safe read ${safe}`);
		}
		for (const core of ["opencode_task", "opencode_spawn", "opencode_wait", "opencode_tools"]) {
			assert.ok(active.includes(core), `missing core tool ${core}`);
		}
		assert.ok(active.includes("opencode_output"));
		assert.ok(active.includes("opencode_workflow"));
		for (const banned of ["bash", "edit", "write", "subagent"]) {
			assert.ok(!active.includes(banned), `${banned} must be removed at session_start`);
		}
	} finally {
		await emit(listeners, "session_shutdown");
		rmSync(tempDir, { recursive: true, force: true });
		if (original === undefined) delete process.env.LOCALAPPDATA;
		else process.env.LOCALAPPDATA = original;
	}
});

test("optional opencode group activation stays additive within the coordinator allowlist", async () => {
	const { tools, active } = activateExtension();
	active.push("read", "grep", "find", "ls", "opencode_task", "opencode_spawn", "opencode_wait", "opencode_tools", "opencode_check");
	const tool = tools.get("opencode_tools");
	assert.ok(tool, "opencode_tools not registered");
	await (tool.execute as (...args: unknown[]) => Promise<unknown>)("id", { group: "inspection" });
	for (const name of ["read", "grep", "find", "ls", "opencode_tools", "opencode_check", "opencode_output", "opencode_list", "opencode_workflow_check", "opencode_workflow_list"]) {
		assert.ok(active.includes(name), `missing ${name} after inspection activation`);
	}
	for (const banned of ["bash", "edit", "write", "apply_patch", "patch", "subagent"]) {
		assert.ok(!active.includes(banned), `${banned} must never be active`);
	}
});

test("tool_call allows safe reads and every opencode orchestration tool", async () => {
	const { listeners } = activateExtension();
	for (const name of ["read", "grep", "find", "ls", "opencode_task", "opencode_spawn", "opencode_wait", "opencode_tools", "opencode_check", "opencode_output", "opencode_cancel", "opencode_list", "opencode_workflow", "opencode_workflow_wait", "opencode_workflow_check", "opencode_workflow_cancel", "opencode_workflow_list"]) {
		const result = await emitToolCall(listeners, { toolCallId: "id", toolName: name, input: {} });
		assert.equal(result, undefined, `${name} should be allowed (no block)`);
	}
});

test("tool_call blocks known and unknown non-orchestration tools", async () => {
	const { listeners } = activateExtension();
	for (const name of ["bash", "edit", "write", "apply_patch", "patch", "subagent", "web_search", "some_unknown_tool"]) {
		const result = await emitToolCall(listeners, { toolCallId: "id", toolName: name, input: {} });
		assert.ok(result, `${name} should be blocked`);
		assert.equal(result.block, true, `${name} block flag`);
		assert.match(result.reason, /Coordinator-only parent/, `${name} reason header`);
		assert.match(result.reason, /delegate/i, `${name} reason mentions delegate`);
	}
});

test("user_bash cancels with a non-zero result without executing", async () => {
	const { listeners } = activateExtension();
	const result = await emitUserBash(listeners, { command: "rm -rf /", excludeFromContext: false, cwd: "/" });
	assert.ok(result?.result, "user_bash should return a result");
	const { result: bashResult } = result!;
	assert.equal(bashResult.exitCode, 1);
	assert.equal(bashResult.cancelled, true);
	assert.equal(bashResult.truncated, false);
	assert.equal(typeof bashResult.output, "string");
});

test("before_agent_start appends the coordinator contract and re-applies the allowlist", async () => {
	const { listeners, active } = activateExtension();
	active.push("read", "bash", "edit", "opencode_output", "opencode_workflow", "subagent");
	const result = await emitBeforeAgentStart(listeners, { systemPrompt: "base system prompt" });
	assert.ok(result?.systemPrompt?.startsWith("base system prompt"));
	const prompt = result!.systemPrompt;
	assert.match(prompt, /Coordinator-only parent contract/);
	assert.match(prompt, /plan, delegate, integrate, and decide/);
	assert.match(prompt, /must be delegated/);
	assert.match(prompt, /read, grep, find, ls/);
	assert.match(prompt, /Never claim workers are sandboxes/);
	// Re-application restored the strict allowlist.
	for (const safe of ["read", "grep", "find", "ls"]) assert.ok(active.includes(safe));
	for (const core of ["opencode_task", "opencode_spawn", "opencode_wait", "opencode_tools"]) assert.ok(active.includes(core));
	assert.ok(active.includes("opencode_output"));
	assert.ok(active.includes("opencode_workflow"));
	for (const banned of ["bash", "edit", "subagent"]) assert.ok(!active.includes(banned));
	// Idempotent: a repeat start with the contract already present appends nothing.
	const second = await emitBeforeAgentStart(listeners, { systemPrompt: prompt });
	assert.equal(second, undefined);
	// The standalone contract helper matches the chained text.
	assert.match(coordinatorContractText(), /Coordinator-only parent contract/);
});

test("dashboard/status/usage and model commands remain registered", () => {
	const { commands } = activateExtension();
	for (const name of ["opencode-status", "opencode-usage", "orch-model"]) {
		assert.ok(commands.has(name), `${name} not registered`);
	}
});

test("tool groups activate additively without dropping unrelated tools", () => {
	const activation = activateToolGroup(["read", "opencode_tools", "opencode_check"], "inspection");
	assert.ok(activation.active.includes("read"));
	assert.ok(activation.active.includes("opencode_tools"));
	assert.ok(activation.active.includes("opencode_output"));
	assert.deepEqual(activation.alreadyActive, ["opencode_check"]);
	assert.ok(activation.loaded.includes("opencode_output"));
	assert.equal(new Set(activation.active).size, activation.active.length);
});

// --- Verified workflow (opencode_verified_task) ---

function verifiedPayload(overrides: Record<string, unknown> = {}) {
	return {
		name: "verified-change",
		objective: "Implement the change",
		relevant_paths: ["src"],
		expected_output: "Report the changed file and summary",
		...overrides,
	};
}

test("opencode_verified_task is registered in the workflows dynamic tool group", () => {
	const { tools } = activateExtension();
	const schema = tools.get("opencode_verified_task")?.parameters;
	assert.ok(schema, "opencode_verified_task not registered");
	const workflowsActivation = activateToolGroup(["opencode_tools"], "workflows");
	assert.ok(workflowsActivation.loaded.includes("opencode_verified_task"));
	const allActivation = activateToolGroup([], "all");
	assert.ok(allActivation.active.includes("opencode_verified_task"));
});

test("opencode_verified_task schema accepts the full verified workflow payload and rejects invalid input", () => {
	const { tools } = activateExtension();
	const schema = tools.get("opencode_verified_task")?.parameters;
	assert.ok(schema, "opencode_verified_task not registered");
	assert.equal(Value.Check(schema, verifiedPayload()), true, "rejected minimal payload");
	assert.equal(
		Value.Check(schema, verifiedPayload({
			constraints: ["Do not touch README"],
			worktree: true,
			implementer_model: "provider/impl",
			tester_model: "provider/test",
			reviewer_model: "provider/review",
			background: false,
		})),
		true,
		"rejected full payload",
	);
	assert.equal(Value.Check(schema, verifiedPayload({ worktree: "yes" })), false, "accepted string worktree");
	assert.equal(Value.Check(schema, verifiedPayload({ relevant_paths: [] })), false, "accepted empty relevant_paths");
	assert.equal(Value.Check(schema, verifiedPayload({ name: "" })), false, "accepted empty name");
});

test("opencode_verified_task documents the requireResolved gate and parent-only final approval", () => {
	const { tools } = activateExtension();
	const tool = tools.get("opencode_verified_task");
	assert.ok(tool, "opencode_verified_task not registered");
	const description = String((tool as { description?: string }).description ?? "");
	assert.match(description, /requireResolved/);
	assert.match(description, /Final approval always stays with the parent/);
	assert.match(description, /no automatic retry/i);
});

// --- Worktree cleanup command & inspection tools ---

function retainedView(overrides: Partial<RetainedWorktreeView> = {}): RetainedWorktreeView {
	return {
		taskId: "oc-1",
		name: "task",
		status: "error",
		error: undefined,
		repo: "repo",
		baseHead: "abc123456789",
		scopes: ["src"],
		changedPaths: ["src/a.ts"],
		conflictPaths: [],
		createdAt: 0,
		patchAvailable: true,
		retryable: true,
		rootIntegrated: false,
		kind: "integration-failure",
		...overrides,
	};
}

interface FakeManager extends RetainedWorktreeManagerLike {
	calls: string[];
}

function fakeManager(views: RetainedWorktreeView[] = []): FakeManager {
	const map = new Map(views.map((view) => [view.taskId, view]));
	const calls: string[] = [];
	return {
		calls,
		listRetainedWorktrees() {
			calls.push("list");
			return [...map.values()];
		},
		getRetainedWorktree(taskId: string) {
			calls.push(`get:${taskId}`);
			const view = map.get(taskId);
			if (!view) throw new Error(`No retained worktree found for task ${taskId}.`);
			return view;
		},
		retryRetainedWorktree(taskId: string) {
			calls.push(`retry:${taskId}`);
			const view = map.get(taskId);
			if (!view) throw new Error(`No retained worktree found for task ${taskId}.`);
			return { ...view, status: "done", error: undefined, retryable: false, rootIntegrated: true, kind: "integration-failure" };
		},
		discardRetainedWorktree(taskId: string) {
			calls.push(`discard:${taskId}`);
			const view = map.get(taskId);
			if (!view) throw new Error(`No retained worktree found for task ${taskId}.`);
			map.delete(taskId);
			return { ...view, error: undefined };
		},
	};
}

test("worktree inspection tools register read-only list/status schemas", () => {
	const { tools } = activateExtension();
	const listSchema = tools.get("opencode_worktree_list")?.parameters;
	const statusSchema = tools.get("opencode_worktree_status")?.parameters;
	assert.ok(listSchema, "opencode_worktree_list not registered");
	assert.ok(statusSchema, "opencode_worktree_status not registered");
	// list takes no parameters; it must not expose any mutation input.
	assert.equal(Value.Check(listSchema, {}), true);
	assert.equal(Value.Check(listSchema, { discard: "oc-1" }), true, "list ignores extra keys (no mutation action)");
	// status requires exactly one string id.
	assert.equal(Value.Check(statusSchema, { id: "oc-1" }), true);
	assert.equal(Value.Check(statusSchema, {}), false);
	assert.equal(Value.Check(statusSchema, { id: 1 }), false);
});

test("worktree inspection tools report empty list and unknown-id status errors", async () => {
	const { tools } = activateExtension();
	const list = tools.get("opencode_worktree_list")!;
	const status = tools.get("opencode_worktree_status")!;
	const listResult = await (list.execute as (...args: unknown[]) => Promise<{ content: { text: string }[] }>)("id", {});
	assert.match(listResult.content[0].text, /No retained worktrees/);
	await assert.rejects(
		() => (status.execute as (...args: unknown[]) => Promise<unknown>)("id", { id: "oc-unknown" }),
		/No retained worktree found/,
	);
});

test("worktree inspection tools join the inspection group and stay coordinator-allowed", async () => {
	const { tools, listeners, active } = activateExtension();
	const activation = activateToolGroup(["opencode_tools"], "inspection");
	for (const name of ["opencode_worktree_list", "opencode_worktree_status"]) {
		assert.ok(activation.active.includes(name), `${name} missing from inspection group`);
	}
	active.push("read", "grep", "find", "ls", "opencode_task", "opencode_spawn", "opencode_wait", "opencode_tools");
	const tool = tools.get("opencode_tools")!;
	assert.ok(tool, "opencode_tools not registered");
	await (tool.execute as (...args: unknown[]) => Promise<unknown>)("id", { group: "inspection" });
	for (const name of ["opencode_worktree_list", "opencode_worktree_status"]) {
		assert.ok(active.includes(name), `${name} not activated by inspection group`);
	}
	for (const name of ["opencode_worktree_list", "opencode_worktree_status"]) {
		const result = await emitToolCall(listeners, { toolCallId: "id", toolName: name, input: {} });
		assert.equal(result, undefined, `${name} should be allowed through the coordinator gate`);
	}
});

test("opencode-worktrees command is registered", () => {
	const { commands } = activateExtension();
	assert.ok(commands.has("opencode-worktrees"), "opencode-worktrees not registered");
});

test("opencode-worktrees list and status work through notify without a UI", async () => {
	const manager = fakeManager([retainedView()]);
	const notified: string[] = [];
	await handleWorktreeCommand(manager, "list", { ui: { notify: (message: string) => notified.push(message) } });
	assert.match(notified[0] ?? "", /oc-1/);
	assert.deepEqual(manager.calls, ["list"]);
	await handleWorktreeCommand(manager, "status oc-1", { ui: { notify: (message: string) => notified.push(message) } });
	assert.match(notified[1] ?? "", /Repository: repo/);
	assert.match(notified[1] ?? "", /Base head: abc123/);
	assert.deepEqual(manager.calls, ["list", "get:oc-1"]);
});

test("opencode-worktrees retry/discard reject without an interactive UI", async () => {
	const manager = fakeManager([retainedView()]);
	const notified: string[] = [];
	await handleWorktreeCommand(manager, "retry oc-1", { hasUI: false, ui: { notify: (message: string) => notified.push(message) } });
	assert.match(notified.join("\n"), /requires an interactive UI/);
	assert.match(notified.join("\n"), /no non-interactive bypass/);
	assert.deepEqual(manager.calls, [], "retry must not reach the manager without UI");

	const notified2: string[] = [];
	await handleWorktreeCommand(manager, "discard oc-1", { ui: { notify: (message: string) => notified2.push(message) } });
	assert.match(notified2.join("\n"), /requires an interactive UI/);
	assert.deepEqual(manager.calls, [], "discard must not reach the manager without UI");
});

test("opencode-worktrees retry/discard cancel (no-op) when confirmation is declined", async () => {
	const manager = fakeManager([retainedView()]);
	const notified: string[] = [];
	await handleWorktreeCommand(manager, "retry oc-1", {
		hasUI: true,
		ui: { notify: (message: string) => notified.push(message), confirm: () => false },
	});
	assert.match(notified.join("\n"), /Cancelled retry/);
	await handleWorktreeCommand(manager, "discard oc-1", {
		hasUI: true,
		ui: { notify: (message: string) => notified.push(message), confirm: () => false },
	});
	assert.match(notified.join("\n"), /Cancelled discard/);
	assert.deepEqual(manager.calls, [], "declined confirmation must not call the manager");
});

test("opencode-worktrees retry integrates and discard cleans up after confirmation", async () => {
	const manager = fakeManager([retainedView()]);
	const notified: string[] = [];
	await handleWorktreeCommand(manager, "retry oc-1", {
		hasUI: true,
		ui: { notify: (message: string) => notified.push(message), confirm: () => true },
	});
	assert.deepEqual(manager.calls, ["retry:oc-1"]);
	assert.match(notified.join("\n"), /Integrated retained worktree/);

	const notified2: string[] = [];
	await handleWorktreeCommand(manager, "discard oc-1", {
		hasUI: true,
		ui: { notify: (message: string) => notified2.push(message), confirm: () => true },
	});
	assert.deepEqual(manager.calls, ["retry:oc-1", "discard:oc-1"]);
	assert.match(notified2.join("\n"), /Discarded retained worktree/);
});

test("opencode-worktrees reports cleanup-failed and retained outcomes", () => {
	const cleanupFailed = retainedView({ status: "done", error: "cleanup failed", kind: "cleanup-failed", rootIntegrated: true });
	assert.match(describeWorktreeMutationOutcome("retry", cleanupFailed), /cleanup failed/);
	assert.match(describeWorktreeMutationOutcome("discard", cleanupFailed), /Cleanup failed/);
	const retained = retainedView({ error: "blocked", rootIntegrated: false });
	assert.match(describeWorktreeMutationOutcome("retry", retained), /entry retained/);
});

test("retained worktree views and formatting expose no absolute temp path", () => {
	const view = retainedView();
	assert.equal("path" in view, false, "retained view must not carry an absolute path");
	for (const text of [formatRetainedWorktreeList([view]), formatRetainedWorktreeDetail(view)]) {
		assert.doesNotMatch(text, /oc-worktrees/);
		assert.doesNotMatch(text, /[A-Za-z]:\\/);
	}
});

test("opencode-worktrees TUI no-args uses select to pick an entry then an action", async () => {
	const manager = fakeManager([retainedView()]);
	const notified: string[] = [];
	const selections: (string | undefined)[] = ["oc-1", "inspect"];
	await handleWorktreeCommand(manager, "", {
		hasUI: true,
		ui: {
			notify: (message: string) => notified.push(message),
			select: async () => selections.shift(),
		},
	});
	assert.deepEqual(manager.calls, ["list", "get:oc-1"]);
	assert.match(notified.join("\n"), /Repository: repo/);
});
