import assert from "node:assert/strict";
import test from "node:test";
import {
	formatDashboard,
	formatElapsed,
	formatLatestActivity,
	formatWorkerRow,
	formatWorkflowPhase,
	formatWorkflowRow,
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
	assert.equal(lines.length, 3);
	assert.equal(lines[0], "OpenCode activity: 1 worker(s), 1 workflow(s)");
	assert.match(lines[1], /oc-1/);
	assert.match(lines[2], /wf-1/);
	assert.equal(formatDashboard([task({ status: "done" })], [workflow({ status: "done" })], 66_000), undefined);
});

test("dashboard stays within the Pi widget line limit and reports omitted workflows", () => {
	const workers = Array.from({ length: 4 }, (_, index) => task({ id: `oc-${index + 1}` }));
	const workflows = Array.from({ length: 7 }, (_, index) => workflow({ id: `wf-${index + 1}` }));
	const lines = formatDashboard(workers, workflows, 66_000);
	assert.ok(lines);
	assert.equal(lines.length, 10);
	assert.match(lines.at(-1) ?? "", /3 more running workflow/);
});
