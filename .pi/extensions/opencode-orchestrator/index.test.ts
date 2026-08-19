import assert from "node:assert/strict";
import test from "node:test";
import {
	activateToolGroup,
	boundParentText,
	compactInitialToolSet,
	formatBatchDeliverable,
	formatRawOutputSlice,
	shouldDelayBackgroundDelivery,
} from "./index.ts";
import type { TaskSnapshot, WorkflowSnapshot } from "./types.ts";

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

test("compact initial tool set preserves unrelated tools and removes optional orchestrator tools", () => {
	const active = compactInitialToolSet(["read", "subagent", "opencode_output", "opencode_workflow"]);
	assert.ok(active.includes("read"));
	assert.ok(active.includes("subagent"));
	for (const core of ["opencode_task", "opencode_spawn", "opencode_wait", "opencode_tools"]) {
		assert.ok(active.includes(core), `missing core tool ${core}`);
	}
	assert.ok(!active.includes("opencode_output"));
	assert.ok(!active.includes("opencode_workflow"));
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
