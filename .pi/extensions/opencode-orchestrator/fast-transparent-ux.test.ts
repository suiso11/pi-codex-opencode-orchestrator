import assert from "node:assert/strict";
import test from "node:test";
import {
	activityFromEvent,
	MAX_ACTIVITY_LABEL_CHARS,
	sanitizeActivityLabel,
} from "./backends/backend.ts";
import {
	coordinatorContractText,
	formatTaskProgress,
	formatTasksProgressText,
	formatWorkflowProgressText,
	startProgressPolling,
} from "./index.ts";
import { configuredThinkingLevel, DEFAULT_THINKING_LEVEL, resolveThinkingLevel } from "./types.ts";
import { formatDashboard } from "./dashboard.ts";
import type { TaskSnapshot, WorkflowSnapshot } from "./types.ts";

function task(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
	return {
		id: "oc-1", name: "demo", mode: "read_only", status: "running", objective: "o",
		relevantPaths: ["src"], scopes: [], model: "m", backend: "opencode",
		createdAt: 1_000, output: "", stderr: "", activity: ["read: running"], timedOut: false,
		truncated: false, ...overrides,
	};
}

test("routine thinking defaults to high while reviewer stays forced high", () => {
	assert.equal(DEFAULT_THINKING_LEVEL, "high");
	assert.equal(configuredThinkingLevel({}), "high");
	assert.equal(configuredThinkingLevel({ PI_OPENCODE_THINKING: "bogus" }), "high");
	assert.equal(resolveThinkingLevel({}, "high"), "high");
	assert.equal(resolveThinkingLevel({ role: "reviewer" }, "high"), "high");
	assert.equal(resolveThinkingLevel({ role: "reviewer", thinking: "low" }, "high"), "high");
	assert.equal(resolveThinkingLevel({ role: "tester" }, "high"), "high");
	assert.equal(resolveThinkingLevel({ role: "tester", thinking: "low" }, "high"), "low");
});

test("activity labels are tool+status with safe targets only", () => {
	assert.equal(
		activityFromEvent({ type: "e", part: { type: "tool", tool: "read", state: { status: "completed" } } }),
		"read: completed",
	);
	const withFile = activityFromEvent({
		type: "e",
		part: { type: "tool", tool: "read", state: { status: "running", input: { file: "src/a.ts" } } },
	});
	assert.match(withFile, /^read: running src\/a\.ts$/);
	// Bash commands are never surfaced as targets.
	const bash = activityFromEvent({
		type: "e",
		part: { type: "tool", tool: "bash", state: { status: "running" }, input: { command: "rm -rf /tmp/x" } },
	});
	assert.equal(bash, "bash: running");
	// Absolute managed paths collapse to basenames.
	const abs = activityFromEvent({
		type: "e",
		part: { type: "tool", tool: "read", state: { status: "running" }, input: { file: "/tmp/oc-worktrees/abc/src/a.ts" } },
	});
	assert.doesNotMatch(abs, /oc-worktrees|\/tmp/);
	assert.match(abs, /a\.ts/);
	const longTarget = activityFromEvent({
		type: "tool_event",
		part: { type: "tool", tool: "read", state: { status: "running" }, input: { file: `src/${"nested/".repeat(20)}target.ts` } },
	});
	assert.match(longTarget, /target\.ts/);
	assert.ok(longTarget.length <= MAX_ACTIVITY_LABEL_CHARS);
	assert.equal(activityFromEvent({ type: "Collie says arbitrary reasoning" }), "event");
	assert.equal(activityFromEvent({ type: "event", part: { type: "Collie says arbitrary reasoning" } }), "event: unknown");
});

test("activity sanitization redacts secrets and bounds length", () => {
	const secret = sanitizeActivityLabel("read: running sk-abcdef1234567890 extra");
	assert.doesNotMatch(secret, /sk-abcdef/);
	assert.match(secret, /\[redacted\]/);
	const long = sanitizeActivityLabel(`read: running ${"x".repeat(500)}`);
	assert.ok(long.length <= MAX_ACTIVITY_LABEL_CHARS);
	assert.equal(MAX_ACTIVITY_LABEL_CHARS, 120);
	const reasoning = activityFromEvent({ type: "message", part: { type: "reasoning", text: "hidden chain of thought" } });
	assert.doesNotMatch(reasoning, /hidden chain/);
});

test("progress formatting is concise, bounded, and leak-free", () => {
	const line = formatTaskProgress(task({ activity: ["edit: running src/a.ts"] }), 13_000);
	assert.match(line, /oc-1 \[running\]/);
	assert.match(line, /12s/);
	assert.match(line, /edit: running/);
	assert.match(formatTaskProgress(task(), 3_727_000), /1h02m/);
	assert.match(formatTaskProgress(task(), 126_000), /2m05s/);
	assert.doesNotMatch(line, /rm -rf|sk-|oc-worktrees/);
	const many = Array.from({ length: 8 }, (_, i) => task({ id: `oc-${i + 1}` }));
	const text = formatTasksProgressText(many);
	assert.ok(text.length <= 800);
	assert.match(text, /more/);
	const wf: WorkflowSnapshot = {
		id: "ow-1", name: "w", status: "running",
		phases: [{ name: "one", tasks: [] }, { name: "two", tasks: [] }],
		currentPhase: 0, taskIds: ["oc-1"], createdAt: 0,
	};
	const wfText = formatWorkflowProgressText(wf, [task()]);
	assert.ok(wfText.length <= 800);
	assert.match(wfText, /ow-1.*phase 1\/2/);
});

test("progress polling updates on an interval and stops cleanly on abort", async () => {
	const controller = new AbortController();
	const updates: unknown[] = [];
	let builds = 0;
	const stop = startProgressPolling(controller.signal, (update: unknown) => updates.push(update), () => `progress ${++builds}`, 1);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(updates.length > 0);
	assert.deepEqual((updates[0] as { details: unknown }).details, { partial: true });
	const count = updates.length;
	controller.abort();
	stop();
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(updates.length, count);
});

test("coordinator guidance states a visible plan and prefers background spawn", () => {
	const contract = coordinatorContractText();
	assert.match(contract, /brief visible plan/);
	assert.match(contract, /Prefer opencode_spawn.*background/);
	assert.match(contract, /only when results are actually needed/);
	assert.match(contract, /high thinking for quality-first results/);
	assert.match(contract, /low explicitly when speed matters/);
	assert.match(contract, /reviewer is always high/);
	assert.match(contract, /concise action\/status summaries/);
});

test("dashboard stays within its 10-line bound", () => {
	const workers = Array.from({ length: 4 }, (_, i) =>
		task({ id: `oc-${i + 1}`, activity: [`read: running file${i}.ts ${"y".repeat(200)}`] }));
	const workflows = Array.from({ length: 7 }, (_, i): WorkflowSnapshot => ({
		id: `wf-${i + 1}`, name: "w", status: "running",
		phases: [{ name: "a", tasks: [] }, { name: "b", tasks: [] }],
		currentPhase: 0, taskIds: [], createdAt: 0,
	}));
	const lines = formatDashboard(workers, workflows, 66_000);
	assert.ok(lines);
	assert.ok(lines.length <= 10);
});
