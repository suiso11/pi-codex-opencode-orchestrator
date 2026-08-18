import assert from "node:assert/strict";
import test from "node:test";
import {
	formatDashboard,
	formatElapsed,
	formatLatestActivity,
	formatTokenTotals,
	formatWorkerRow,
	formatWorkflowPhase,
	formatWorkflowRow,
	sumWorkerUsage,
} from "./dashboard.ts";
import type { TaskSnapshot, WorkflowSnapshot } from "./types.ts";

function task(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
	return {
		id: "oc-1",
		name: "implement dashboard",
		mode: "write",
		status: "running",
		objective: "Build UI",
		relevantPaths: ["src"],
		scopes: ["/repo/src"],
		model: "opencode-go/glm-5.2",
		backend: "opencode",
		createdAt: 1_000,
		output: "",
		stderr: "",
		activity: ["read: completed", "edit: running"],
		timedOut: false,
		truncated: false,
		...overrides,
	};
}

function workflow(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
	return {
		id: "wf-1",
		name: "dashboard workflow",
		status: "running",
		phases: [
			{ name: "research", tasks: [] },
			{ name: "implementation", tasks: [] },
		],
		currentPhase: 1,
		taskIds: ["oc-1"],
		createdAt: 1_000,
		...overrides,
	};
}

test("formats elapsed time across seconds, minutes, and hours", () => {
	assert.equal(formatElapsed(31_000, 1_000), "30s");
	assert.equal(formatElapsed(126_000, 1_000), "2m05s");
	assert.equal(formatElapsed(3_726_000, 1_000), "1h02m");
	assert.equal(formatElapsed(0, 1_000), "0s");
});

test("uses the latest worker activity with a starting fallback", () => {
	assert.equal(formatLatestActivity(["read: running", "bash: completed"]), "bash: completed");
	assert.equal(formatLatestActivity([]), "starting");
});

test("worker row includes model, elapsed, mode, name, and activity", () => {
	const row = formatWorkerRow(task(), 66_000);
	assert.match(row, /oc-1/);
	assert.match(row, /opencode-go\/glm-5\.2/);
	assert.match(row, /1m05s/);
	assert.match(row, /\[write\]/);
	assert.match(row, /implement dashboard/);
	assert.match(row, /edit: running/);
});

test("workflow row includes elapsed time and current phase", () => {
	const item = workflow();
	assert.equal(formatWorkflowPhase(item), "2/2 implementation");
	const row = formatWorkflowRow(item, 66_000);
	assert.match(row, /wf-1/);
	assert.match(row, /1m05s/);
	assert.match(row, /phase 2\/2 implementation/);
});

test("dashboard shows only running work and disappears when idle", () => {
	const lines = formatDashboard(
		[task(), task({ id: "oc-2", status: "done", settledAt: 2_000 })],
		[workflow()],
		66_000,
	);
	assert.ok(lines);
	assert.equal(lines.length, 4);
	assert.equal(lines[0], "Worker activity: 1 worker(s), 1 workflow(s)");
	assert.match(lines[1], /^Tokens: /);
	assert.match(lines[2], /oc-1/);
	assert.match(lines[3], /wf-1/);
	assert.equal(formatDashboard([task({ status: "done" })], [workflow({ status: "done" })], 66_000), undefined);
});

test("dashboard stays within the Pi widget line limit and reports omitted workflows", () => {
	const workers = Array.from({ length: 4 }, (_, index) => task({ id: `oc-${index + 1}` }));
	const workflows = Array.from({ length: 7 }, (_, index) => workflow({ id: `wf-${index + 1}` }));
	const lines = formatDashboard(workers, workflows, 66_000);
	assert.ok(lines);
	assert.equal(lines.length, 10);
	assert.match(lines.at(-1) ?? "", /4 more running workflow/);
});

test("sumWorkerUsage aggregates input, output, total, and cost across tasks", () => {
	const tasks = [
		task({ id: "oc-a", usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.01 } }),
		task({ id: "oc-b", usage: { inputTokens: 200, outputTokens: 75, totalTokens: 275, cost: 0.02 } }),
		task({ id: "oc-c" }),
	];
	const totals = sumWorkerUsage(tasks);
	assert.equal(totals.inputTokens, 300);
	assert.equal(totals.outputTokens, 125);
	assert.equal(totals.totalTokens, 425);
	assert.equal(Math.round(totals.cost * 1000), 30);
});

test("formatTokenTotals reports parent and worker totals compactly", () => {
	const tasks = [
		task({ id: "oc-a", usage: { inputTokens: 1_000, outputTokens: 400, totalTokens: 1_400, cost: 0.05 } }),
	];
	const parent = { inputTokens: 12_000, outputTokens: 3_000, totalTokens: 15_000, cost: 0.2 };
	const line = formatTokenTotals(tasks, { parent });
	assert.match(line, /^Tokens: parent in 12,000\/out 3,000\/15,000 · workers in 1,000\/out 400\/1,400$/);
});

test("formatTokenTotals omits parent section when no parent usage is supplied", () => {
	const line = formatTokenTotals([task({ usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } })]);
	assert.match(line, /^Tokens: workers in 5\/out 2\/7$/);
	assert.doesNotMatch(line, /parent/);
});

test("formatTokenTotals handles tasks with no usage as zeros", () => {
	const line = formatTokenTotals([task(), task({ id: "oc-2" })]);
	assert.match(line, /^Tokens: workers in 0\/out 0\/0$/);
});
