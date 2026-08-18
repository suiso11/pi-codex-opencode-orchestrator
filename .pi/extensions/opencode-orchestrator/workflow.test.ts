import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { OpenCodeTaskManager } from "./manager.ts";
import type { TaskSnapshot, WorkflowPhaseSpec, WorkflowSnapshot } from "./types.ts";
import { buildPhaseHandoff, formatWorkflowResultText, OpenCodeWorkflowManager } from "./workflow.ts";

async function fakeOpenCode() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "fake-opencode-workflow-"));
	const script = path.join(dir, "opencode.mjs");
	await writeFile(
		script,
		`
const prompt = process.argv.at(-1) || "";
function emit(text) {
  process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text } }) + "\\n");
}
if (prompt.includes("Objective: research phase")) {
  const report = {
    summary: "PHASE_ONE_SUMMARY",
    files: ["src/a.ts"],
    findings: ["FOUND_ALPHA"],
    unresolved: ["BLOCKER_BETA"],
  };
  emit(JSON.stringify(report) + " RAW_FILLER_SHOULD_NOT_LEAK " + "x".repeat(20000) + " trailing");
  process.exit(0);
}
const findings = [];
if (prompt.includes("PHASE_ONE_SUMMARY")) findings.push("HAS_STRUCTURED_SUMMARY");
if (prompt.includes("FOUND_ALPHA")) findings.push("HAS_FINDING");
if (prompt.includes("src/a.ts")) findings.push("HAS_FILE");
if (prompt.includes("BLOCKER_BETA")) findings.push("HAS_UNRESOLVED");
if (prompt.includes("RAW_FILLER_SHOULD_NOT_LEAK")) findings.push("LEAKED_RAW_FILLER");
else findings.push("NO_RAW_FILLER");
if (prompt.includes("Inspect changed files directly")) findings.push("HAS_WRITE_REMINDER");
const marker = "Previous phase results";
const idx = prompt.indexOf(marker);
let handoffLen = 0;
if (idx >= 0) {
  const after = prompt.slice(idx);
  for (const line of after.split("\\n")) {
    const t = line.trim();
    if (t.startsWith("{") && t.includes("tasks")) { handoffLen = t.length; break; }
  }
}
findings.push("HANDOFF_LEN_" + handoffLen);
findings.push(handoffLen > 0 && handoffLen <= 4000 ? "HANDOFF_BOUNDED" : (handoffLen === 0 ? "NO_HANDOFF_FOUND" : "HANDOFF_OVER_4000"));
emit(JSON.stringify({ summary: "downstream done", files: [], findings, unresolved: [] }));
process.exit(0);
`,
	);
	return {
		binary: process.execPath,
		binaryArgs: [script],
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

test("workflow runs phases sequentially and passes compact structured prior results forward", async () => {
	const fake = await fakeOpenCode();
	const tasks = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	const workflows = new OpenCodeWorkflowManager(tasks);
	const phases: WorkflowPhaseSpec[] = [
		{
			name: "research",
			tasks: [{
				name: "first",
				mode: "read_only",
				objective: "research phase",
				relevantPaths: ["src"],
				constraints: [],
				expectedOutput: "research result",
			}],
		},
		{
			name: "integration",
			tasks: [{
				name: "second",
				mode: "read_only",
				objective: "integration phase",
				relevantPaths: ["src"],
				constraints: [],
				expectedOutput: "integrated result",
				profile: "kimi_k3",
			}],
		},
	];

	try {
		const started = workflows.start("context handoff", phases, process.cwd());
		const settled = await workflows.wait(started.id);
		assert.equal(settled.status, "done");
		assert.equal(settled.taskIds.length, 2);
		assert.match(tasks.get(settled.taskIds[0])?.output ?? "", /PHASE_ONE_SUMMARY/);
		const second = tasks.get(settled.taskIds[1]);
		assert.equal(second?.model, "opencode-go/kimi-k3");
		const findings = second?.report?.findings ?? [];
		assert.ok(findings.includes("HAS_STRUCTURED_SUMMARY"), "second phase missing structured prior summary");
		assert.ok(findings.includes("NO_RAW_FILLER"), "second phase leaked raw filler");
		assert.ok(!findings.includes("LEAKED_RAW_FILLER"), "second phase reports leaked raw filler");
		assert.ok(findings.includes("HANDOFF_BOUNDED"), "second phase handoff not bounded to 4000");
		assert.ok((settled.handoffCharsCreated ?? 0) > 0, "no handoff chars recorded");
		assert.ok((settled.handoffCharsCreated ?? 0) <= 4000, "handoff exceeds 4000 chars");
		assert.equal(settled.handoffCharsInjected, settled.handoffCharsCreated, "single downstream task should not multiply");
	} finally {
		await workflows.dispose();
		await tasks.dispose();
		await fake.cleanup();
	}
});

test("workflow records handoff multiplication metrics and excludes raw filler for multi-task downstream phase", async () => {
	const fake = await fakeOpenCode();
	const tasks = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	const workflows = new OpenCodeWorkflowManager(tasks);
	const phases: WorkflowPhaseSpec[] = [
		{
			name: "research",
			tasks: [{
				name: "first",
				mode: "read_only",
				objective: "research phase",
				relevantPaths: ["src"],
				constraints: [],
				expectedOutput: "research result",
			}],
		},
		{
			name: "fix",
			tasks: [
				{
					name: "fix-a",
					mode: "write",
					objective: "fix phase a",
					relevantPaths: ["src/zone-a"],
					constraints: [],
					expectedOutput: "fix result a",
				},
				{
					name: "fix-b",
					mode: "write",
					objective: "fix phase b",
					relevantPaths: ["src/zone-b"],
					constraints: [],
					expectedOutput: "fix result b",
				},
			],
		},
	];

	try {
		const started = workflows.start("multi-task handoff", phases, process.cwd());
		const settled = await workflows.wait(started.id);
		assert.equal(settled.status, "done");
		assert.equal(settled.taskIds.length, 3);
		assert.match(tasks.get(settled.taskIds[0])?.output ?? "", /RAW_FILLER_SHOULD_NOT_LEAK/);
		for (const id of [settled.taskIds[1], settled.taskIds[2]]) {
			const task = tasks.get(id);
			const findings = task?.report?.findings ?? [];
			assert.ok(findings.includes("HAS_STRUCTURED_SUMMARY"), `${id} missing structured summary`);
			assert.ok(findings.includes("NO_RAW_FILLER"), `${id} leaked raw filler`);
			assert.ok(!findings.includes("LEAKED_RAW_FILLER"), `${id} reports leaked raw filler`);
			assert.ok(findings.includes("HANDOFF_BOUNDED"), `${id} handoff not bounded to 4000`);
			assert.ok(findings.includes("HAS_WRITE_REMINDER"), `${id} missing write-worker reminder`);
		}
		const created = settled.handoffCharsCreated ?? 0;
		const injected = settled.handoffCharsInjected ?? 0;
		assert.ok(created > 0 && created <= 4000, `created out of range: ${created}`);
		assert.equal(injected, created * 2, `expected injected=${created * 2} got ${injected}`);
		assert.ok(injected > created, "no multiplication observed for multi-task downstream phase");
	} finally {
		await workflows.dispose();
		await tasks.dispose();
		await fake.cleanup();
	}
});

async function fakeSlowDownstreamOpenCode() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "fake-opencode-workflow-cancel-"));
	const script = path.join(dir, "opencode.mjs");
	await writeFile(script, `
const prompt = process.argv.at(-1) || "";
if (prompt.includes("Objective: seed phase")) {
  process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text: JSON.stringify({ summary: "seed", files: [], findings: ["ready"], unresolved: [] }) } }) + "\\n");
  process.exit(0);
}
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text: JSON.stringify({ summary: "late", files: [], findings: [], unresolved: [] }) } }) + "\\n");
}, 5000);
`);
	return {
		binary: process.execPath,
		binaryArgs: [script],
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for workflow state");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("workflow handoff injection metrics count only tasks actually spawned before cancellation", async () => {
	const fake = await fakeSlowDownstreamOpenCode();
	const tasks = new OpenCodeTaskManager({ binary: fake.binary, binaryArgs: fake.binaryArgs, timeoutMs: 10_000 });
	const workflows = new OpenCodeWorkflowManager(tasks);
	const downstream = Array.from({ length: 5 }, (_, index) => ({
		name: `slow-${index}`,
		mode: "read_only" as const,
		objective: `slow downstream ${index}`,
		relevantPaths: ["src"],
		constraints: [],
		expectedOutput: "result",
	}));
	try {
		const started = workflows.start("cancel metrics", [
			{ name: "seed", tasks: [{
				name: "seed", mode: "read_only", objective: "seed phase", relevantPaths: ["src"],
				constraints: [], expectedOutput: "seed result",
			}] },
			{ name: "slow", tasks: downstream },
		], process.cwd());
		await waitUntil(() => started.taskIds.length === 5 || started.status !== "running"); // seed + four workers at the global cap
		assert.equal(started.status, "running", `workflow stopped early: ${started.error ?? "unknown"}; tasks=${started.taskIds.length}; stderr=${tasks.get(started.taskIds[0] ?? "")?.stderr}`);
		const settled = await workflows.cancel(started.id);
		const created = settled.handoffCharsCreated ?? 0;
		assert.equal(settled.status, "cancelled");
		assert.ok(created > 0);
		assert.equal(settled.handoffCharsInjected, created * 4);
	} finally {
		await workflows.dispose();
		await tasks.dispose();
		await fake.cleanup();
	}
});

function makeTaskSnapshot(overrides: Partial<TaskSnapshot> & { id: string }): TaskSnapshot {
	return {
		name: `task-${overrides.id}`,
		mode: "read_only",
		status: "done",
		objective: "x",
		relevantPaths: ["src"],
		scopes: ["src"],
		model: "m",
		backend: "opencode",
		createdAt: 0,
		output: "",
		stderr: "",
		activity: [],
		timedOut: false,
		truncated: false,
		report: { summary: "", files: [], findings: [], unresolved: [] },
		...overrides,
	};
}

test("buildPhaseHandoff always returns valid JSON within 4000 chars for large inputs", () => {
	const tasks: TaskSnapshot[] = [];
	for (let i = 0; i < 64; i++) {
		tasks.push(makeTaskSnapshot({
			id: `oc-${i}`,
			report: {
				summary: "S".repeat(500),
				files: Array.from({ length: 20 }, (_, j) => `file-${j}-${"f".repeat(200)}`),
				findings: Array.from({ length: 10 }, (_, j) => `finding-${j}-${"g".repeat(300)}`),
				unresolved: Array.from({ length: 10 }, (_, j) => `unresolved-${j}-${"h".repeat(200)}`),
			},
		}));
	}
	const handoff = buildPhaseHandoff(tasks);
	assert.ok(handoff.length <= 4000, `handoff length ${handoff.length} > 4000`);
	const parsed = JSON.parse(handoff);
	assert.ok(typeof parsed === "object" && parsed !== null);
	assert.ok(Array.isArray(parsed.tasks));
});

test("buildPhaseHandoff falls back to valid JSON when even one minimal task exceeds 4000", () => {
	const tasks: TaskSnapshot[] = [
		makeTaskSnapshot({ id: "I".repeat(5_000), report: { summary: "x", files: [], findings: [], unresolved: [] } }),
	];
	const handoff = buildPhaseHandoff(tasks);
	assert.ok(handoff.length <= 4000, `fallback length ${handoff.length} > 4000`);
	const parsed = JSON.parse(handoff);
	assert.ok(typeof parsed === "object" && parsed !== null);
	assert.ok(Array.isArray(parsed.tasks));
	assert.equal(parsed.tasks.length, 0);
	assert.equal(parsed.omittedTasks, 1);
});

test("formatWorkflowResultText never exceeds 8000 chars including headers and truncation marker", () => {
	const workflow: WorkflowSnapshot = {
		id: "ow-large",
		name: "large-result-workflow",
		status: "done",
		phases: [{ name: "solo", tasks: [] }],
		taskIds: ["oc-a", "oc-b"],
		createdAt: 0,
		settledAt: 1_000,
		handoffCharsCreated: 3_500,
		handoffCharsInjected: 7_000,
	};
	const results: TaskSnapshot[] = [
		makeTaskSnapshot({
			id: "oc-a",
			name: "task-with-huge-report",
			mode: "read_only",
			output: "x".repeat(50_000),
			report: {
				summary: "S".repeat(1000),
				files: Array.from({ length: 16 }, (_, i) => `file-${i}-${"f".repeat(240)}`),
				findings: Array.from({ length: 16 }, (_, i) => `finding-${i}-${"g".repeat(480)}`),
				unresolved: Array.from({ length: 16 }, (_, i) => `unresolved-${i}-${"h".repeat(480)}`),
			},
		}),
		makeTaskSnapshot({
			id: "oc-b",
			name: "task-with-huge-raw-output",
			mode: "write",
			output: "y".repeat(50_000),
			stderr: "e".repeat(5_000),
			truncated: true,
		}),
	];
	const text = formatWorkflowResultText(workflow, results);
	assert.ok(text.length > 0, "resultText empty");
	assert.ok(text.length <= 8000, `resultText length ${text.length} > 8000`);
});
