import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	buildReleaseArgs,
	buildReportArgs,
	deriveHerdrStatus,
	HERDR_AGENT,
	HERDR_SOURCE,
	HerdrStatusReporter,
	resolveHerdrEnv,
} from "./herdr.ts";
import type { TaskSnapshot, WorkflowSnapshot } from "./types.ts";

function task(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
	return {
		id: "oc-1", name: "task", mode: "read_only", status: "done", objective: "test",
		relevantPaths: ["src"], scopes: [], model: "model", backend: "opencode",
		createdAt: 0, settledAt: 1, output: "", stderr: "", activity: [], timedOut: false,
		truncated: false, ...overrides,
	};
}

function workflow(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
	return {
		id: "ow-1", name: "workflow", status: "done", phases: [
			{ name: "one", tasks: [] }, { name: "two", tasks: [] },
		], taskIds: [], createdAt: 0, settledAt: 1, ...overrides,
	};
}

test("resolveHerdrEnv enables only with HERDR_ENV=1 plus pane id and bin path", () => {
	assert.equal(resolveHerdrEnv({}), undefined);
	assert.equal(resolveHerdrEnv({ HERDR_ENV: "1" }), undefined);
	assert.equal(resolveHerdrEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }), undefined);
	assert.equal(resolveHerdrEnv({ HERDR_ENV: "1", HERDR_BIN_PATH: "herdr" }), undefined);
	assert.equal(resolveHerdrEnv({ HERDR_ENV: "0", HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: "herdr" }), undefined);
	const enabled = resolveHerdrEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: "herdr" });
	assert.deepEqual(enabled, { paneId: "w1:p1", binPath: "herdr" });
	// Whitespace-only values stay disabled.
	assert.equal(resolveHerdrEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "  ", HERDR_BIN_PATH: "herdr" }), undefined);
});

test("deriveHerdrStatus maps orchestrator state to idle/working/blocked", () => {
	assert.deepEqual(deriveHerdrStatus([task()], [workflow()]), {
		state: "idle",
		message: "no running workers or workflows",
	});
	const working = deriveHerdrStatus([task({ status: "running" })], [workflow({ status: "running" })]);
	assert.equal(working.state, "working");
	assert.match(working.message, /1 worker\(s\) running, 1 workflow\(s\) running/);

	// Retained/cleanup-failed worktrees block, regardless of running work.
	const blocked = deriveHerdrStatus(
		[task({ status: "running", worktree: { isolated: true, baseHead: "abc", status: "retained", changedPaths: [] } })],
		[],
	);
	assert.equal(blocked.state, "blocked");
	assert.match(blocked.message, /1 retained worktree\(s\) awaiting decision/);
	const cleanupFailed = deriveHerdrStatus([
		task({ worktree: { isolated: true, baseHead: "abc", status: "cleanup-failed", changedPaths: [] } }),
	], []);
	assert.equal(cleanupFailed.state, "blocked");
	assert.match(cleanupFailed.message, /\(1 cleanup-failed\)/);
});

test("deriveHerdrStatus messages carry counts only, never paths or scopes", () => {
	const statuses = [
		deriveHerdrStatus([task({ status: "running", relevantPaths: ["/abs/path"], scopes: ["src/secret.ts"] })], []),
		deriveHerdrStatus([task({ worktree: { isolated: true, baseHead: "abc", status: "retained", changedPaths: [] } })], []),
	];
	for (const status of statuses) {
		assert.doesNotMatch(status.message, /[A-Za-z]:[\\/]/);
		assert.doesNotMatch(status.message, /secret|src\//);
	}
});

test("report and release args use the official CLI protocol with source and agent", () => {
	const report = buildReportArgs("w1:p1", { state: "working", message: "1 worker(s) running, 0 workflow(s) running" }, 3);
	assert.deepEqual(report, [
		"pane", "report-agent", "w1:p1",
		"--source", HERDR_SOURCE, "--agent", HERDR_AGENT,
		"--state", "working", "--message", "1 worker(s) running, 0 workflow(s) running", "--seq", "3",
	]);
	assert.equal(HERDR_SOURCE, "custom:pi-orch");
	assert.equal(HERDR_AGENT, "pi-orch");
	const release = buildReleaseArgs("w1:p1", 4);
	assert.deepEqual(release, [
		"pane", "release-agent", "w1:p1", "--source", HERDR_SOURCE, "--agent", HERDR_AGENT, "--seq", "4",
	]);
});

// Fake Herdr CLI: a cross-platform Node script that logs its CLI args as JSONL
// to the file given through HERDR_FAKE_LOG, optionally exiting non-zero.
// HERDR_FAKE_MODE="slow-first" delays the seq-1 call's log write past any later
// calls: if dispatches overlap, later seqs land first and the log order
// reverses; a serialized reporter always keeps seq order.
async function fakeHerdr() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "fake-herdr-"));
	const script = path.join(dir, "herdr.mjs");
	const log = path.join(dir, "calls.jsonl");
	await writeFile(
		script,
		`
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const write = () => appendFileSync(process.env.HERDR_FAKE_LOG, JSON.stringify(args) + "\\n");
const seqIndex = args.indexOf("--seq");
const slow = process.env.HERDR_FAKE_MODE === "slow-first" && args[seqIndex + 1] === "1";
if (slow) setTimeout(write, 250); else write();
if (process.env.HERDR_FAKE_MODE === "fail") process.exit(2);
`,
	);
	return {
		dir,
		log,
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

test("reporter sends report-agent only on status change and release-agent at shutdown", async () => {
	const fake = await fakeHerdr();
	process.env.HERDR_FAKE_LOG = fake.log;
	process.env.HERDR_FAKE_MODE = "ok";
	try {
		const reporter = new HerdrStatusReporter({
			env: { paneId: "w1:p1", binPath: process.execPath },
			binArgs: [path.join(fake.dir, "herdr.mjs")],
		});
		// First report goes out.
		reporter.report([task({ status: "running" })], []);
		// Same coarse state, even with a changed count: no second call.
		reporter.report([task({ status: "running" }), task({ id: "oc-2", status: "running" })], []);
		assert.equal(reporter.reportsCount, 1);
		// Status change: second call with a monotonically higher seq.
		reporter.report([], []);
		assert.equal(reporter.reportsCount, 2);
		// No-op after release.
		reporter.release();
		reporter.release();
		reporter.report([task({ status: "running" })], []);
		assert.equal(reporter.reportsCount, 2);

		await reporter.flush();
		const lines = (await readFile(fake.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(lines.length, 3, `expected 3 CLI calls, got ${lines.length}`);
		assert.equal(lines[0][1], "report-agent");
		assert.match(lines[0].join(" "), /--source custom:pi-orch --agent pi-orch --state working/);
		assert.match(lines[0].join(" "), /--seq 1/);
		assert.match(lines[1].join(" "), /--state idle/);
		assert.match(lines[1].join(" "), /--seq 2/);
		assert.equal(lines[2][1], "release-agent");
		assert.match(lines[2].join(" "), /--seq 3/);
		assert.equal(reporter.lastStatus?.state, "idle");
		assert.equal(reporter.diagnostics.length, 0);
	} finally {
		delete process.env.HERDR_FAKE_LOG;
		delete process.env.HERDR_FAKE_MODE;
		await fake.cleanup();
	}
});

test("reporter serializes dispatches: a slow seq-1 CLI call cannot be overtaken by later seqs", async () => {
	const fake = await fakeHerdr();
	process.env.HERDR_FAKE_LOG = fake.log;
	process.env.HERDR_FAKE_MODE = "slow-first";
	try {
		const reporter = new HerdrStatusReporter({
			env: { paneId: "w1:p1", binPath: process.execPath },
			binArgs: [path.join(fake.dir, "herdr.mjs")],
		});
		reporter.report([task({ status: "running" })], []);
		reporter.report([], []);
		reporter.release();
		await reporter.flush();
		const lines = (await readFile(fake.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(lines.map((line) => line[1]), ["report-agent", "report-agent", "release-agent"]);
		assert.deepEqual(
			lines.map((line) => line[line.indexOf("--seq") + 1]),
			["1", "2", "3"],
		);
		assert.equal(reporter.diagnostics.length, 0);
	} finally {
		delete process.env.HERDR_FAKE_LOG;
		delete process.env.HERDR_FAKE_MODE;
		await fake.cleanup();
	}
});

test("reporter confines CLI failures to diagnostics without throwing", async () => {
	const fake = await fakeHerdr();
	process.env.HERDR_FAKE_LOG = fake.log;
	process.env.HERDR_FAKE_MODE = "fail";
	try {
		const reporter = new HerdrStatusReporter({
			env: { paneId: "w1:p1", binPath: process.execPath },
			binArgs: [path.join(fake.dir, "herdr.mjs")],
		});
		assert.doesNotThrow(() => reporter.report([task({ status: "running" })], []));
		assert.doesNotThrow(() => reporter.release());
		await reporter.flush();
		assert.ok(reporter.diagnostics.length >= 2, `diagnostics=${JSON.stringify(reporter.diagnostics)}`);
		assert.match(reporter.diagnostics[0], /^herdr report failed \(seq 1\): /);
		// Diagnostics stay path-free.
		assert.doesNotMatch(reporter.diagnostics.join("\n"), /[A-Za-z]:[\\/]/);
	} finally {
		delete process.env.HERDR_FAKE_LOG;
		delete process.env.HERDR_FAKE_MODE;
		await fake.cleanup();
	}
});

test("reporter survives a missing CLI binary and keeps diagnostics bounded", async () => {
	const reporter = new HerdrStatusReporter({
		env: { paneId: "w1:p1", binPath: "definitely-not-a-real-herdr-binary" },
		maxDiagnostics: 3,
	});
	for (let index = 0; index < 10; index += 1) {
		// Alternate statuses so every iteration dispatches.
		reporter.report(index % 2 === 0 ? [task({ status: "running" })] : [], []);
	}
	reporter.release();
	await reporter.flush();
	assert.ok(reporter.diagnostics.length <= 3, `bounded diagnostics: ${reporter.diagnostics.length}`);
	assert.ok(reporter.diagnostics.every((line) => line.startsWith("herdr ")));
});
