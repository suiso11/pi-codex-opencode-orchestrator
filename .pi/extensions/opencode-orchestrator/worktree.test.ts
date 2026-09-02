import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { OpenCodeTaskManager } from "./manager.ts";
import type { RetainedWorktreeView, TaskSnapshot } from "./types.ts";

// Fake child binary: a Node script that inspects its prompt (the last argv
// argument) and mutates its own working directory accordingly. The manager runs
// a worktree child with cwd inside the detached worktree, so these writes land
// in isolation and integrate only through the batch queue.
async function fakeWorker() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "fake-worker-"));
	const script = path.join(dir, "worker.mjs");
	await writeFile(
		script,
		`
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
const prompt = process.argv.at(-1) || "";
const emit = (text) => process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text } }) + "\\n");
if (prompt.includes("ECHO_CWD")) emit("CWD=" + process.cwd());
if (prompt.includes("WRITE_SRC_A")) { mkdirSync("src", { recursive: true }); writeFileSync("src/a.txt", "A-from-worker\\n", "utf8"); }
if (prompt.includes("WRITE_SRC_B")) { mkdirSync("src", { recursive: true }); writeFileSync("src/b.txt", "B-from-worker\\n", "utf8"); }
if (prompt.includes("WRITE_CWD_MARKER")) writeFileSync("cwd-marker.txt", "cwd-marker\\n", "utf8");
if (prompt.includes("REPORT_ABS_FILE")) {
  emit(JSON.stringify({ summary: "worker report", files: [path.join(process.cwd(), "src", "reported.txt")], findings: [], unresolved: [] }));
}
if (prompt.includes("STDERR_CWD")) process.stderr.write("ERR_CWD=" + process.cwd() + "\\n");
if (prompt.includes("ACTIVITY_PATH")) {
  process.stdout.write(JSON.stringify({ type: "activity", part: { type: "tool", tool: process.cwd(), state: { status: "running" } } }) + "\\n");
}
if (prompt.includes("WRITE_UNTRACKED")) writeFileSync("untracked.txt", "untracked\\n", "utf8");
if (prompt.includes("WRITE_BINARY")) writeFileSync("bin.dat", Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
if (prompt.includes("MODIFY_BASE")) writeFileSync("base.txt", "base-modified-by-worker\\n", "utf8");
if (prompt.includes("DELETE_TRACKED")) unlinkSync("delete-me.txt");
if (prompt.includes("WRITE_OUT_OF_SCOPE")) { mkdirSync("outsiders", { recursive: true }); writeFileSync("outsiders/out.txt", "out-of-scope\\n", "utf8"); }
if (prompt.includes("GIT_COMMIT")) {
  execFileSync("git", ["-c", "user.name=worker", "-c", "user.email=worker@example.com", "commit", "-am", "worker commit", "--allow-empty"], { cwd: process.cwd(), stdio: "ignore" });
}
if (prompt.includes("GITLINK")) {
  // Embed a real nested git repo so the outer "git add -A" stages a gitlink (160000).
  mkdirSync("sub", { recursive: true });
  execFileSync("git", ["-C", "sub", "init", "-q"], { cwd: process.cwd(), stdio: "ignore" });
  writeFileSync("sub/s.txt", "s\\n", "utf8");
  execFileSync("git", ["-C", "sub", "add", "-A"], { cwd: process.cwd(), stdio: "ignore" });
  execFileSync("git", ["-C", "sub", "-c", "user.name=sub", "-c", "user.email=sub@example.com", "commit", "-q", "-m", "sub"], { cwd: process.cwd(), stdio: "ignore" });
}
if (prompt.includes("NEVER_EXIT")) { setInterval(() => {}, 1000); await new Promise(() => {}); process.exit(0); }
const delay = prompt.includes("SLOW") ? 800 : (prompt.includes("SLOW_SHORT") ? 250 : 20);
if (prompt.includes("ERROR_EXIT")) { emit("ERROR_WORKER"); process.exit(7); }
setTimeout(() => emit("DONE"), delay);
`,
		"utf8",
	);
	return {
		binary: process.execPath,
		binaryArgs: [script],
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

function spec(name: string, mode: "read_only" | "write", relevantPaths: string[], objective = name) {
	return {
		name,
		mode,
		objective,
		relevantPaths,
		constraints: [],
		expectedOutput: "result",
	};
}

// Temp Git repo whose root path contains both Japanese and a space, per the
// "Japanese/space paths required" requirement. Contains a tracked binary file
// and a cwd-relative subdirectory for the isolation tests.
async function fakeGitRepo() {
	const base = await mkdtemp(path.join(os.tmpdir(), "wt-テスト-"));
	const dir = path.join(base, "リポジトリ スペース");
	await mkdir(path.join(dir, "src"), { recursive: true });
	await mkdir(path.join(dir, "サブ ディレクトリ"), { recursive: true });
	const git = (args: string[]) =>
		execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
	git(["init", "-q"]);
	// Keep LF line endings exactly as written so integration content assertions
	// are stable on Windows regardless of core.autocrlf defaults.
	git(["config", "core.autocrlf", "false"]);
	const files: Record<string, string | Uint8Array> = {
		"base.txt": "base\n",
		"src/a.txt": "a\n",
		"src/b.txt": "b\n",
		"bin.dat": new Uint8Array([1, 2, 3, 4]),
		"delete-me.txt": "delete me\n",
		"サブ ディレクトリ/inside.txt": "inside\n",
	};
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(dir, rel);
		await mkdir(path.dirname(abs), { recursive: true });
		await writeFile(abs, content);
	}
	git(["add", "-A"]);
	git(["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "base"]);
	return {
		dir,
		git,
		subDir: path.join(dir, "サブ ディレクトリ"),
		baseHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim(),
		cleanup: () => rm(base, { recursive: true, force: true }),
	};
}

// Replicate JSON string escaping (backslashes doubled, quotes/control escaped)
// so tests can assert on JSON-escaped worktree paths embedded in worker output.
function jsonStringEscape(value: string): string {
	return JSON.stringify(value).slice(1, -1);
}

// Replicate the manager's stable OS-temp worktree base directory for a repo so
// tests can assert on physical worktree/patch existence and clean up retained
// worktrees. It derives the toplevel through git (the same source the manager
// uses) to guarantee the digest matches exactly.
function worktreeBaseDir(repoDir: string) {
	const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
		cwd: repoDir,
		encoding: "utf8",
	}).trim();
	const repoRoot = path.resolve(toplevel);
	const digest = createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
	return { repoRoot, baseDir: path.join(os.tmpdir(), "oc-worktrees", digest) };
}

// Bounded cleanup: safely remove any intentionally retained worktrees with
// `git worktree remove --force`, prune, then remove the manager's temp-root
// directory and the disposable repo. Failing removes are ignored (already gone).
async function cleanupRepo(repo: { dir: string; cleanup: () => Promise<void> }, snapshotIds: string[]) {
	const { repoRoot, baseDir } = worktreeBaseDir(repo.dir);
	for (const id of snapshotIds) {
		const wt = path.join(baseDir, id);
		try {
			execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: repoRoot, stdio: "ignore" });
		} catch {
			// The worktree may already have been removed by a successful integration.
		}
	}
	try {
		execFileSync("git", ["worktree", "prune"], { cwd: repoRoot, stdio: "ignore" });
	} catch {
		// Nothing to prune.
	}
	// Remove the manager's temp-root directory. Windows may briefly lock the dir
	// after git subprocesses exit, so retry and tolerate a leftover empty dir.
	try {
		await rm(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	} catch {
		// Best-effort: an empty leftover temp dir is harmless and os-cleaned.
	}
	await repo.cleanup();
}

// Every surface that can reach a model or user after settle must be free of the
// absolute worktree/state/patch layout under the OS temp root, in both literal
// and JSON-string-escaped spellings.
function assertNoWorktreePathsLeak(snapshot: TaskSnapshot) {
	const surfaces: string[] = [
		snapshot.output,
		snapshot.stderr,
		snapshot.error ?? "",
		snapshot.worktree?.error ?? "",
		...snapshot.activity,
	];
	if (snapshot.report) {
		surfaces.push(
			snapshot.report.summary,
			...snapshot.report.files,
			...snapshot.report.findings,
			...snapshot.report.unresolved,
		);
	}
	const escapedTmp = jsonStringEscape(os.tmpdir());
	for (const surface of surfaces) {
		assert.ok(!surface.includes("oc-worktrees"), "settled surface must not expose the worktree temp root");
		assert.ok(
			!surface.includes(os.tmpdir()) && !surface.includes(escapedTmp),
			"settled surface must not expose the OS temp dir, literal or JSON-escaped",
		);
	}
}

test("dirty root rejects a worktree batch while a single direct write remains allowed", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	await writeFile(path.join(repo.dir, "base.txt"), "dirty\n", "utf8");
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	try {
		assert.throws(
			() => manager.spawn({ ...spec("wt-dirty", "write", ["src/a.txt"]), worktree: true }, repo.dir),
			/requires a clean Git root/,
		);
		const direct = manager.spawn(spec("direct-dirty", "write", ["src/a.txt"], "WRITE_SRC_A"), repo.dir);
		const [settled] = await manager.wait([direct.id]);
		assert.equal(settled.status, "done");
		assert.equal(settled.worktree, undefined, "a single direct write is not isolated");
		assert.equal(await readFile(path.join(repo.dir, "base.txt"), "utf8"), "dirty\n");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, []);
	}
});

test("concurrent non-isolated writes and direct/worktree mixes are rejected", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	let retainedId = "";
	try {
		// direct/direct
		const directA = manager.spawn(spec("direct-a", "write", ["src/a.txt"], "SLOW_SHORT"), repo.dir);
		assert.throws(
			() => manager.spawn(spec("direct-b", "write", ["src/b.txt"]), repo.dir),
			/Concurrent write tasks require every currently running write task/,
		);
		await manager.cancel([directA.id]);

		// worktree/direct: the running isolated write does not license a direct write
		const wtA = manager.spawn(
			{ ...spec("wt-a", "write", ["src/a.txt"], "SLOW_SHORT"), worktree: true },
			repo.dir,
		);
		retainedId = wtA.id;
		assert.throws(
			() => manager.spawn(spec("direct-c", "write", ["src/b.txt"]), repo.dir),
			/Concurrent write tasks require every currently running write task/,
		);
		await manager.cancel([wtA.id]);

		// direct/worktree: a direct write blocks an opt-in worktree write
		const directD = manager.spawn(spec("direct-d", "write", ["src/b.txt"], "SLOW_SHORT"), repo.dir);
		assert.throws(
			() => manager.spawn({ ...spec("wt-b", "write", ["src/a.txt"]), worktree: true }, repo.dir),
			/Concurrent write tasks require every currently running write task/,
		);
		await manager.cancel([directD.id]);
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [retainedId]);
	}
});

test("two disjoint worktree writes run concurrently and integrate into the root in deterministic ID order", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	let idA = "";
	let idB = "";
	try {
		const a = manager.spawn(
			{ ...spec("wt-a", "write", ["src/a.txt"], "WRITE_SRC_A"), worktree: true },
			repo.dir,
		);
		idA = a.id;
		const b = manager.spawn(
			{ ...spec("wt-b", "write", ["src/b.txt"], "WRITE_SRC_B"), worktree: true },
			repo.dir,
		);
		idB = b.id;
		assert.equal(manager.runningCount(), 2);
		const [settledA, settledB] = await manager.wait([a.id, b.id]);
		assert.equal(settledA.status, "done");
		assert.equal(settledB.status, "done");
		assert.equal(settledA.worktree?.status, "integrated");
		assert.equal(settledB.worktree?.status, "integrated");
		assert.equal(await readFile(path.join(repo.dir, "src", "a.txt"), "utf8"), "A-from-worker\n");
		assert.equal(await readFile(path.join(repo.dir, "src", "b.txt"), "utf8"), "B-from-worker\n");
		assert.ok(settledA.settledAt !== undefined && settledB.settledAt !== undefined);
		assert.ok(
			settledA.settledAt <= settledB.settledAt,
			"lower-ID worktree task must finalize (and thus integrate) before the higher-ID task",
		);
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [idA, idB]);
	}
});

test("child cwd is the isolated worktree preserving the original cwd-relative subdirectory", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	let id = "";
	try {
		const started = manager.spawn(
			{
				...spec(
					"wt-subdir",
					"write",
					["src/a.txt", "cwd-marker.txt"],
					"WRITE_SRC_A WRITE_CWD_MARKER ECHO_CWD STDERR_CWD ACTIVITY_PATH",
				),
				worktree: true,
			},
			repo.subDir,
		);
		id = started.id;
		// The child cwd is the worktree subdirectory, so its relative writes must
		// not reach the original repository directly while isolated.
		assert.equal(manager.get(id)?.status, "running");
		assert.ok(
			!existsSync(path.join(repo.subDir, "cwd-marker.txt")),
			"isolated writes must not reach the original repository before integration",
		);
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		assert.equal(settled.worktree?.status, "integrated");
		// Settle-time path redaction hides the absolute worktree cwd on every surface.
		assert.match(settled.output, /CWD=<worktree>/, "worker cwd must be redacted to the <worktree> marker");
		assert.ok(settled.output.includes("<worktree>"), "output must carry the redaction marker");
		assert.ok(!settled.output.includes("oc-worktrees"), "output must not leak the worktree temp root");
		assert.ok(!settled.output.includes(os.tmpdir()), "output must not leak the OS temp dir");
		assert.ok(settled.stderr.includes("<worktree>"), "stderr cwd must be redacted");
		assert.ok(
			!settled.stderr.includes("oc-worktrees") && !settled.stderr.includes(os.tmpdir()),
			"stderr must not leak worktree paths",
		);
		assert.ok(settled.activity.some((item) => item.includes("<worktree>")), "activity cwd must be redacted");
		assertNoWorktreePathsLeak(settled);
		// The in-scope marker written relative to the child cwd integrates back
		// into the root's Japanese/space subdirectory, proving subdirectory
		// preservation, and the cwd-relative write never touched the original repo.
		assert.equal(await readFile(path.join(repo.subDir, "cwd-marker.txt"), "utf8"), "cwd-marker\n");
		assert.equal(await readFile(path.join(repo.subDir, "src", "a.txt"), "utf8"), "A-from-worker\n");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [id]);
	}
});

test("absolute worktree-relative report.files paths become repo-relative after settle", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	let id = "";
	try {
		const started = manager.spawn(
			{ ...spec("wt-report", "write", ["src/a.txt"], "REPORT_ABS_FILE ECHO_CWD"), worktree: true },
			repo.subDir,
		);
		id = started.id;
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		assert.equal(settled.worktree?.status, "integrated");
		// The structured report's absolute worktree path is mapped repo-relative,
		// preserving the Japanese/space subdirectory.
		assert.deepEqual(
			settled.report?.files,
			["サブ ディレクトリ/src/reported.txt"],
			"absolute worktree file paths must become repo-relative in the settled report",
		);
		assert.ok(settled.report?.files.every((file) => !path.isAbsolute(file)), "report files must be repo-relative");
		assert.ok(
			settled.report?.files.every((file) => !file.includes("oc-worktrees") && !file.includes(os.tmpdir())),
			"repo-relative report files must not leak the worktree layout",
		);
		// The raw worker text the report was parsed from is the JSON event that
		// embedded the absolute worktree path, so on Windows it arrives with
		// doubled (JSON-escaped) backslashes. Both the literal and the
		// JSON-escaped spellings of the temp worktree/state/cwd layout must be
		// gone from every settled surface, while the repo-relative report.files
		// remain intact.
		const escapedTmp = jsonStringEscape(os.tmpdir());
		for (const surface of [
			settled.output,
			settled.stderr,
			settled.error ?? "",
			...settled.activity,
		]) {
			assert.ok(
				!surface.includes("oc-worktrees") && !surface.includes(os.tmpdir()) && !surface.includes(escapedTmp),
				"settled output/activity/error/stderr must not leak the temp worktree layout, literal or JSON-escaped",
			);
		}
		assert.ok(
			!settled.report?.summary.includes(os.tmpdir()) &&
				!settled.report?.summary.includes(escapedTmp) &&
				settled.report?.findings.every((f) => !f.includes("oc-worktrees") && !f.includes(os.tmpdir()) && !f.includes(escapedTmp)) &&
				settled.report?.unresolved.every((u) => !u.includes("oc-worktrees") && !u.includes(os.tmpdir()) && !u.includes(escapedTmp)),
			"structured report must not leak the temp worktree layout, literal or JSON-escaped",
		);
		assert.match(settled.output, /CWD=<worktree>/, "plain-text cwd must be redacted");
		assert.ok(
			!settled.stderr.includes("oc-worktrees") && !settled.stderr.includes(os.tmpdir()),
			"stderr must not leak worktree paths",
		);
		assert.ok(
			settled.activity.every((item) => !item.includes("oc-worktrees") && !item.includes(os.tmpdir())),
			"activity must not leak worktree paths",
		);
		// The same repo-relative report is what downstream consumers receive.
		assert.deepEqual(manager.get(id)?.report?.files, ["サブ ディレクトリ/src/reported.txt"]);
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [id]);
	}
});

test("rejected worktree integration surfaces expose no absolute worktree/state/patch paths after settle", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	const retained: string[] = [];
	try {
		// Out-of-scope rejection: every settle surface must be redacted.
		const out = manager.spawn(
			{
				...spec(
					"wt-redact-out",
					"write",
					["src/a.txt"],
					"WRITE_OUT_OF_SCOPE WRITE_SRC_A ECHO_CWD STDERR_CWD ACTIVITY_PATH",
				),
				worktree: true,
			},
			repo.dir,
		);
		retained.push(out.id);
		const [settledOut] = await manager.wait([out.id]);
		assert.equal(settledOut.status, "error");
		assert.equal(settledOut.worktree?.status, "retained");
		assert.match(settledOut.worktree?.error ?? "", /Out-of-scope change detected: outsiders\/out\.txt/);
		assert.match(settledOut.output, /CWD=<worktree>/, "output cwd must be redacted");
		assert.ok(settledOut.stderr.includes("<worktree>"), "stderr cwd must be redacted");
		assert.ok(settledOut.activity.some((item) => item.includes("<worktree>")), "activity must be redacted");
		assertNoWorktreePathsLeak(settledOut);

		// Worker commit/HEAD movement rejection.
		const commit = manager.spawn(
			{ ...spec("wt-redact-commit", "write", ["src/a.txt"], "WRITE_SRC_A GIT_COMMIT ECHO_CWD"), worktree: true },
			repo.dir,
		);
		retained.push(commit.id);
		const [settledCommit] = await manager.wait([commit.id]);
		assert.equal(settledCommit.status, "error");
		assert.equal(settledCommit.worktree?.status, "retained");
		assert.match(settledCommit.worktree?.error ?? "", /Worker moved its worktree HEAD/);
		assert.match(settledCommit.output, /CWD=<worktree>/, "output cwd must be redacted");
		assertNoWorktreePathsLeak(settledCommit);

		// Apply-phase rejection: an external root mutation poisons the batch.
		const a = manager.spawn(
			{ ...spec("wt-redact-a", "write", ["src/a.txt"], "WRITE_SRC_A SLOW ECHO_CWD"), worktree: true },
			repo.dir,
		);
		const b = manager.spawn(
			{ ...spec("wt-redact-b", "write", ["src/b.txt"], "WRITE_SRC_B ECHO_CWD"), worktree: true },
			repo.dir,
		);
		retained.push(a.id, b.id);
		await writeFile(path.join(repo.dir, "base.txt"), "external-mutation\n", "utf8");
		const results = await manager.wait([a.id, b.id]);
		const byId = new Map(results.map((r) => [r.id, r]));
		assert.equal(byId.get(a.id)?.status, "error");
		assert.equal(byId.get(b.id)?.status, "error");
		assert.match(byId.get(a.id)?.worktree?.error ?? "", /External mutation detected at the repository root/);
		assert.match(byId.get(b.id)?.worktree?.error ?? "", /Batch integration aborted after an external root mutation/);
		assert.match(byId.get(a.id)?.output ?? "", /CWD=<worktree>/, "output cwd must be redacted");
		assert.match(byId.get(b.id)?.output ?? "", /CWD=<worktree>/, "output cwd must be redacted");
		assertNoWorktreePathsLeak(byId.get(a.id)!);
		assertNoWorktreePathsLeak(byId.get(b.id)!);
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, retained);
	}
});

test("untracked, binary, tracked-modify, and deletion changes integrate", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	let id = "";
	try {
		const started = manager.spawn(
			{
				...spec("wt-mix", "write", ["."], "WRITE_UNTRACKED WRITE_BINARY MODIFY_BASE DELETE_TRACKED"),
				worktree: true,
			},
			repo.dir,
		);
		id = started.id;
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		assert.equal(settled.worktree?.status, "integrated");
		assert.deepEqual(settled.worktree?.changedPaths?.sort(), [
			"base.txt",
			"bin.dat",
			"delete-me.txt",
			"untracked.txt",
		]);
		assert.equal(await readFile(path.join(repo.dir, "untracked.txt"), "utf8"), "untracked\n");
		assert.equal(await readFile(path.join(repo.dir, "base.txt"), "utf8"), "base-modified-by-worker\n");
		const binary = await readFile(path.join(repo.dir, "bin.dat"));
		assert.deepEqual([...binary], Array.from({ length: 256 }, (_, i) => i));
		assert.ok(!existsSync(path.join(repo.dir, "delete-me.txt")), "deletion must reach the root");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [id]);
	}
});

test("out-of-scope change rejects integration and retains the worktree", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	let id = "";
	try {
		const started = manager.spawn(
			{ ...spec("wt-out", "write", ["src/a.txt"], "WRITE_OUT_OF_SCOPE WRITE_SRC_A"), worktree: true },
			repo.dir,
		);
		id = started.id;
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "error");
		assert.equal(settled.worktree?.status, "retained");
		assert.match(settled.worktree?.error ?? "", /Out-of-scope change detected: outsiders\/out\.txt/);
		assert.ok(!existsSync(path.join(repo.dir, "outsiders", "out.txt")), "out-of-scope content must never reach the root");
		assert.equal(await readFile(path.join(repo.dir, "src", "a.txt"), "utf8"), "a\n");
		const { baseDir } = worktreeBaseDir(repo.dir);
		assert.ok(existsSync(path.join(baseDir, id)), "retained worktree path must still exist");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [id]);
	}
});

test("worker commit/HEAD movement rejects integration and retains the worktree", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	let id = "";
	try {
		const started = manager.spawn(
			{ ...spec("wt-commit", "write", ["src/a.txt"], "WRITE_SRC_A GIT_COMMIT"), worktree: true },
			repo.dir,
		);
		id = started.id;
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "error");
		assert.equal(settled.worktree?.status, "retained");
		assert.match(settled.worktree?.error ?? "", /Worker moved its worktree HEAD \(git commit detected\)/);
		assert.equal(await readFile(path.join(repo.dir, "src", "a.txt"), "utf8"), "a\n");
		const { baseDir } = worktreeBaseDir(repo.dir);
		assert.ok(existsSync(path.join(baseDir, id)), "retained worktree path must still exist");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [id]);
	}
});

test("submodule/gitlink change rejects integration and retains the worktree", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	let id = "";
	try {
		const started = manager.spawn(
			{ ...spec("wt-gitlink", "write", ["src/a.txt"], "GITLINK"), worktree: true },
			repo.dir,
		);
		id = started.id;
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "error");
		assert.equal(settled.worktree?.status, "retained");
		assert.match(settled.worktree?.error ?? "", /submodule\/gitlink changes/);
		assert.ok(!existsSync(path.join(repo.dir, "sub")), "gitlink content must never reach the root");
		const { baseDir } = worktreeBaseDir(repo.dir);
		assert.ok(existsSync(path.join(baseDir, id)), "retained worktree path must still exist");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [id]);
	}
});

test("worker error never integrates and retains metadata and path", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	let id = "";
	try {
		const started = manager.spawn(
			{ ...spec("wt-error", "write", ["src/a.txt"], "WRITE_SRC_A ERROR_EXIT"), worktree: true },
			repo.dir,
		);
		id = started.id;
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "error");
		assert.equal(settled.exitCode, 7);
		assert.equal(settled.worktree?.status, "retained");
		assert.match(settled.worktree?.error ?? "", /exited with code 7/);
		assert.equal(await readFile(path.join(repo.dir, "src", "a.txt"), "utf8"), "a\n");
		const { baseDir } = worktreeBaseDir(repo.dir);
		assert.ok(existsSync(path.join(baseDir, id)), "retained worktree path must still exist");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [id]);
	}
});

test("cancel never integrates and retains metadata and path", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	let id = "";
	try {
		const started = manager.spawn(
			{ ...spec("wt-cancel", "write", ["src/a.txt"], "WRITE_SRC_A SLOW"), worktree: true },
			repo.dir,
		);
		id = started.id;
		const [settled] = await manager.cancel([started.id]);
		assert.equal(settled.status, "cancelled");
		assert.equal(settled.worktree?.status, "retained");
		assert.match(settled.worktree?.error ?? "", /worker did not exit cleanly/);
		assert.equal(await readFile(path.join(repo.dir, "src", "a.txt"), "utf8"), "a\n");
		const { baseDir } = worktreeBaseDir(repo.dir);
		assert.ok(existsSync(path.join(baseDir, id)), "retained worktree path must still exist");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [id]);
	}
});

test("timeout never integrates and retains metadata and path", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	// The manager clamps the worker timeout to a 10s minimum, so this test takes
	// about 10s but stays well within the 180s budget.
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 500,
	});
	let id = "";
	try {
		const started = manager.spawn(
			{ ...spec("wt-timeout", "write", ["src/a.txt"], "NEVER_EXIT"), worktree: true },
			repo.dir,
		);
		id = started.id;
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "error");
		assert.equal(settled.timedOut, true);
		assert.equal(settled.worktree?.status, "retained");
		assert.match(settled.worktree?.error ?? "", /timed out after/);
		assert.equal(await readFile(path.join(repo.dir, "src", "a.txt"), "utf8"), "a\n");
		const { baseDir } = worktreeBaseDir(repo.dir);
		assert.ok(existsSync(path.join(baseDir, id)), "retained worktree path must still exist");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [id]);
	}
});

test("external root mutation before integration conflicts and retains both worktrees with root scoped content untouched", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	let idA = "";
	let idB = "";
	try {
		const a = manager.spawn(
			{ ...spec("wt-ext-a", "write", ["src/a.txt"], "WRITE_SRC_A SLOW"), worktree: true },
			repo.dir,
		);
		const b = manager.spawn(
			{ ...spec("wt-ext-b", "write", ["src/b.txt"], "WRITE_SRC_B"), worktree: true },
			repo.dir,
		);
		idA = a.id;
		idB = b.id;
		// External root mutation while the batch is still open and A is still running.
		await writeFile(path.join(repo.dir, "base.txt"), "external-mutation\n", "utf8");
		const results = await manager.wait([a.id, b.id]);
		const byId = new Map(results.map((r) => [r.id, r]));
		assert.equal(byId.get(a.id)?.status, "error");
		assert.equal(byId.get(b.id)?.status, "error");
		assert.match(byId.get(a.id)?.worktree?.error ?? "", /External mutation detected at the repository root/);
		assert.match(byId.get(b.id)?.worktree?.error ?? "", /Batch integration aborted after an external root mutation/);
		assert.equal(await readFile(path.join(repo.dir, "base.txt"), "utf8"), "external-mutation\n");
		assert.equal(await readFile(path.join(repo.dir, "src", "b.txt"), "utf8"), "b\n", "scoped content must not integrate after external mutation");
		assert.equal(await readFile(path.join(repo.dir, "src", "a.txt"), "utf8"), "a\n");
		const { baseDir } = worktreeBaseDir(repo.dir);
		assert.ok(existsSync(path.join(baseDir, idA)), "retained worktree path must still exist");
		assert.ok(existsSync(path.join(baseDir, idB)), "retained worktree path must still exist");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [idA, idB]);
	}
});

test("same-commit branch switch poisons integration even when the root stays clean", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({ binary: fake.binary, binaryArgs: fake.binaryArgs, timeoutMs: 2_000 });
	let id = "";
	try {
		const started = manager.spawn(
			{ ...spec("wt-branch-switch", "write", ["src/a.txt"], "WRITE_SRC_A SLOW"), worktree: true },
			repo.dir,
		);
		id = started.id;
		repo.git(["branch", "same-commit"]);
		repo.git(["checkout", "-q", "same-commit"]);
		const [settled] = await manager.wait([id]);
		assert.equal(settled.status, "error");
		assert.match(settled.worktree?.error ?? "", /External mutation detected at the repository root/);
		assert.equal(await readFile(path.join(repo.dir, "src", "a.txt"), "utf8"), "a\n");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [id]);
	}
});

test("successful no-op integration removes the worktree and temp patch", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	const started = manager.spawn({ ...spec("wt-noop", "write", ["src/a.txt"]), worktree: true }, repo.dir);
	const { baseDir } = worktreeBaseDir(repo.dir);
	const wtPath = path.join(baseDir, started.id);
	const patchPath = path.join(baseDir, `${started.id}.patch`);
	try {
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		assert.equal(settled.worktree?.status, "integrated");
		assert.deepEqual(settled.worktree?.changedPaths, []);
		assert.equal(await readFile(path.join(repo.dir, "src", "a.txt"), "utf8"), "a\n");
		assert.ok(!existsSync(wtPath), "worktree must be removed after a successful no-op integration");
		assert.ok(!existsSync(patchPath), "temp patch must be removed after a successful no-op integration");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [started.id]);
	}
});

test("successful change integration removes worktree/patch; waiter resolves only after integration and settledAt follows finalization", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	const started = manager.spawn(
		{ ...spec("wt-change", "write", ["src/a.txt"], "WRITE_SRC_A"), worktree: true },
		repo.dir,
	);
	const { baseDir } = worktreeBaseDir(repo.dir);
	const wtPath = path.join(baseDir, started.id);
	const patchPath = path.join(baseDir, `${started.id}.patch`);
	try {
		// While running, isolation is pending and the root is untouched.
		assert.equal(manager.get(started.id)?.status, "running");
		assert.equal(manager.get(started.id)?.worktree?.status, "pending");
		assert.equal(await readFile(path.join(repo.dir, "src", "a.txt"), "utf8"), "a\n");
		const beforeWait = Date.now();
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		assert.equal(settled.worktree?.status, "integrated");
		assert.equal(settled.worktree?.baseHead, repo.baseHead);
		assert.deepEqual(settled.worktree?.changedPaths, ["src/a.txt"]);
		assert.ok(settled.settledAt !== undefined, "settledAt must be recorded");
		assert.ok(settled.settledAt >= started.createdAt, "settledAt must follow creation");
		assert.ok(settled.settledAt >= beforeWait, "settledAt is recorded at finalization, after integration");
		// Integration completed before the waiter resolved.
		assert.equal(await readFile(path.join(repo.dir, "src", "a.txt"), "utf8"), "A-from-worker\n");
		assert.ok(!existsSync(wtPath), "worktree must be removed after a successful integration");
		assert.ok(!existsSync(patchPath), "temp patch must be removed after a successful integration");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [started.id]);
	}
});

// Produce a current-session retained integration-failure (retryable=true, root
// unmodified) by externally mutating the root while a worktree batch is open, so
// the validated patch is rejected at apply time and retained.
async function retainedIntegrationFailure(manager: OpenCodeTaskManager, repoDir: string, name = "wt-retry-src") {
	const started = manager.spawn(
		{ ...spec(name, "write", ["src/a.txt"], "WRITE_SRC_A SLOW"), worktree: true },
		repoDir,
	);
	await writeFile(path.join(repoDir, "base.txt"), "ext\n", "utf8");
	const [settled] = await manager.wait([started.id]);
	assert.equal(settled.status, "error");
	assert.match(settled.worktree?.error ?? "", /External mutation detected at the repository root/);
	// Retry deliberately accepts only a clean root at the original base HEAD.
	// Restore the external sentinel after producing the retained failure.
	await writeFile(path.join(repoDir, "base.txt"), "base\n", "utf8");
	const view = manager.getRetainedWorktree(started.id);
	assert.equal(view.retryable, true, "validated patch with a clean original-base root must be retryable");
	return started.id;
}

function assertViewNoTempLeak(view: RetainedWorktreeView) {
	const escapedTmp = jsonStringEscape(os.tmpdir());
	assert.ok(
		!view.error?.includes("oc-worktrees") &&
			!view.error?.includes(os.tmpdir()) &&
			!view.error?.includes(escapedTmp),
		"retained error must not leak the temp worktree layout, literal or JSON-escaped",
	);
	for (const p of [...view.scopes, ...view.changedPaths, ...view.conflictPaths]) {
		assert.ok(!path.isAbsolute(p), "retained paths must be repo-relative");
		assert.ok(
			!p.includes("oc-worktrees") && !p.includes(os.tmpdir()) && !p.includes(escapedTmp),
			"retained paths must not leak the temp layout",
		);
	}
}

test("retained worktree list/detail views are serializable with no absolute temp paths", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	let id = "";
	try {
		const started = manager.spawn(
			{
				...spec(
					"wt-view",
					"write",
					["src/a.txt", "サブ ディレクトリ"],
					"WRITE_SRC_A SLOW",
				),
				worktree: true,
			},
			repo.dir,
		);
		id = started.id;
		await writeFile(path.join(repo.dir, "base.txt"), "ext\n", "utf8");
		await manager.wait([started.id]);
		const views = manager.listRetainedWorktrees();
		assert.equal(views.length, 1);
		const detail = manager.getRetainedWorktree(id);
		assert.deepEqual(views[0], detail);
		assert.equal(detail.taskId, id);
		assert.equal(detail.name, "wt-view");
		assert.equal(detail.status, "error");
		assert.equal(detail.retryable, true);
		assert.equal(detail.rootIntegrated, false);
		assert.equal(detail.patchAvailable, true);
		assert.equal(detail.baseHead.length, 12, "baseHead is a short SHA");
		assert.ok(detail.repo.length > 0 && !detail.repo.includes(path.sep), "repo is a basename, not a path");
		assert.deepEqual(detail.scopes, ["src/a.txt", "サブ ディレクトリ"]);
		assert.ok(Array.isArray(detail.changedPaths) && Array.isArray(detail.conflictPaths));
		for (const view of views) assertViewNoTempLeak(view);
		// Serializability: the view survives JSON round-trip unchanged.
		assert.deepEqual(JSON.parse(JSON.stringify(detail)), detail);
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [id]);
	}
});

test("retry of a retained integration failure applies synchronously and updates the original snapshot", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	let id = "";
	try {
		id = await retainedIntegrationFailure(manager, repo.dir, "wt-retry-ok");
		assert.equal(await readFile(path.join(repo.dir, "src", "a.txt"), "utf8"), "a\n", "root untouched before retry");
		const result = manager.retryRetainedWorktree(id);
		assert.equal(result.rootIntegrated, true);
		assert.equal(await readFile(path.join(repo.dir, "src", "a.txt"), "utf8"), "A-from-worker\n");
		const updated = manager.get(id)!;
		assert.equal(updated.status, "done");
		assert.equal(updated.worktree?.status, "integrated");
		assert.equal(updated.error, undefined);
		assert.equal(updated.worktree?.error, undefined);
		assert.ok(
			!manager.listRetainedWorktrees().some((view) => view.taskId === id),
			"integrated entry is no longer retained",
		);
		const { baseDir } = worktreeBaseDir(repo.dir);
		assert.ok(!existsSync(path.join(baseDir, id)), "worktree removed after successful retry");
		assert.ok(!existsSync(path.join(baseDir, `${id}.patch`)), "patch removed after successful retry");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [id]);
	}
});

test("patch archives use randomized exclusive files and retry consumes the retained buffer", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({ binary: fake.binary, binaryArgs: fake.binaryArgs, timeoutMs: 2_000 });
	let id = "";
	try {
		id = await retainedIntegrationFailure(manager, repo.dir, "wt-buffer-retry");
		const { baseDir } = worktreeBaseDir(repo.dir);
		const archives = (await readdir(baseDir)).filter((name) => /^patch-[0-9a-f]{48}\.patch$/.test(name));
		assert.equal(archives.length, 1, "a non-empty patch must have one randomized archive");
		assert.notEqual(archives[0], `${id}.patch`, "the task id must not determine the archive name");
		const archivePath = path.join(baseDir, archives[0]);
		const archiveStats = await lstat(archivePath);
		assert.equal(archiveStats.isFile(), true, "archive must be a regular file");
		assert.equal(archiveStats.nlink, 1, "archive must not be hardlinked");
		// An attacker changing the retained archive must not change the bytes
		// used by retry; retry is required to consume the manager-held buffer.
		await writeFile(archivePath, Buffer.from("not the validated patch\n"));
		const result = manager.retryRetainedWorktree(id);
		assert.equal(result.rootIntegrated, true);
		assert.equal(await readFile(path.join(repo.dir, "src", "a.txt"), "utf8"), "A-from-worker\n");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [id]);
	}
});

test("predictable patch collision and symlink substitution are never used or overwritten", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({ binary: fake.binary, binaryArgs: fake.binaryArgs, timeoutMs: 2_000 });
	let id = "";
	try {
		const started = manager.spawn(
			{ ...spec("wt-patch-collision", "write", ["src/a.txt"], "WRITE_SRC_A SLOW"), worktree: true },
			repo.dir,
		);
		id = started.id;
		const { baseDir } = worktreeBaseDir(repo.dir);
		const sentinel = path.join(baseDir, "archive-sentinel");
		const predictable = path.join(baseDir, `${id}.patch`);
		await writeFile(sentinel, "sentinel\n", "utf8");
		let usedSymlink = true;
		try {
			await symlink(path.basename(sentinel), predictable, "file");
		} catch {
			// Some Windows configurations deny symlink creation; a hardlink still
			// exercises the fail-closed existing-path collision.
			usedSymlink = false;
			await link(sentinel, predictable);
		}
		const [settled] = await manager.wait([id]);
		assert.equal(settled.status, "done");
		assert.equal(await readFile(sentinel, "utf8"), "sentinel\n", "existing collision target must remain unchanged");
		assert.equal((await lstat(predictable)).isSymbolicLink(), usedSymlink);
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [id]);
	}
});

test("retry conflict never mutates the repository root", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	let id = "";
	try {
		id = await retainedIntegrationFailure(manager, repo.dir, "wt-retry-conflict");
		// Introduce a conflicting root change so the patch no longer applies.
		await writeFile(path.join(repo.dir, "src", "a.txt"), "conflict\n", "utf8");
		assert.throws(() => manager.retryRetainedWorktree(id), /clean repository root/);
		assert.equal(await readFile(path.join(repo.dir, "src", "a.txt"), "utf8"), "conflict\n", "root must be untouched");
		assert.equal(await readFile(path.join(repo.dir, "base.txt"), "utf8"), "base\n");
		const still = manager.getRetainedWorktree(id);
		assert.equal(still.retryable, true, "entry remains retryable after a clean rejection");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [id]);
	}
});

test("retry rejects retained entries without a previously validated patch", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	const ids: string[] = [];
	try {
		// Worker failure: no validated patch.
		const errTask = manager.spawn(
			{ ...spec("wt-retry-nopatch", "write", ["src/a.txt"], "WRITE_SRC_A ERROR_EXIT"), worktree: true },
			repo.dir,
		);
		ids.push(errTask.id);
		await manager.wait([errTask.id]);
		assert.equal(manager.getRetainedWorktree(errTask.id).patchAvailable, false);
		assert.throws(() => manager.retryRetainedWorktree(errTask.id), /not retryable/);

		// Out-of-scope: no valid patch; conflict paths are repo-relative.
		const oos = manager.spawn(
			{ ...spec("wt-retry-oos", "write", ["src/a.txt"], "WRITE_OUT_OF_SCOPE WRITE_SRC_A"), worktree: true },
			repo.dir,
		);
		ids.push(oos.id);
		await manager.wait([oos.id]);
		const view = manager.getRetainedWorktree(oos.id);
		assert.equal(view.retryable, false);
		assert.equal(view.patchAvailable, false);
		assert.deepEqual(view.conflictPaths, ["outsiders/out.txt"]);
		assert.throws(() => manager.retryRetainedWorktree(oos.id), /not retryable/);
		assertViewNoTempLeak(view);
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, ids);
	}
});

test("retry is blocked while any task runs or a batch is open in the same repository", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	let id = "";
	let blockerId = "";
	try {
		id = await retainedIntegrationFailure(manager, repo.dir, "wt-block-src");
		// Restore the external mutation so a new batch can open in the same repo.
		await writeFile(path.join(repo.dir, "base.txt"), "base\n", "utf8");
		const blocker = manager.spawn(
			{ ...spec("wt-block-b", "write", ["src/b.txt"], "SLOW"), worktree: true },
			repo.dir,
		);
		blockerId = blocker.id;
		assert.equal(manager.get(blockerId)?.status, "running");
		assert.throws(() => manager.retryRetainedWorktree(id), /same repository/);
		await manager.wait([blockerId]);
		// After the blocker settles, retry is allowed again.
		const result = manager.retryRetainedWorktree(id);
		assert.equal(result.rootIntegrated, true);
		assert.equal(await readFile(path.join(repo.dir, "src", "a.txt"), "utf8"), "A-from-worker\n");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [id, blockerId]);
	}
});

test("retry in one repository is independent of running activity in another", async () => {
	const fake = await fakeWorker();
	const repoA = await fakeGitRepo();
	const repoB = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	let idA = "";
	let idB = "";
	try {
		idA = await retainedIntegrationFailure(manager, repoA.dir, "wt-indep-a");
		// A running worktree task in a different repository must not block retry of A.
		const b = manager.spawn(
			{ ...spec("wt-indep-b", "write", ["src/b.txt"], "WRITE_SRC_B SLOW"), worktree: true },
			repoB.dir,
		);
		idB = b.id;
		assert.equal(manager.get(idB)?.status, "running");
		const result = manager.retryRetainedWorktree(idA);
		assert.equal(result.rootIntegrated, true);
		assert.equal(await readFile(path.join(repoA.dir, "src", "a.txt"), "utf8"), "A-from-worker\n");
		await manager.wait([b.id]);
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repoA, [idA]);
		await cleanupRepo(repoB, [idB]);
	}
});

test("discard is blocked only by same-repository activity; other-repo running tasks do not block", async () => {
	const fake = await fakeWorker();
	const repoA = await fakeGitRepo();
	const repoB = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	let idA = "";
	let blockerId = "";
	let idB = "";
	try {
		// Retained entry in repoA via worker failure; the root is untouched and
		// stays clean, so a new batch can open in the same repository.
		const retained = manager.spawn(
			{ ...spec("wt-discard-guard-a", "write", ["src/a.txt"], "WRITE_SRC_A ERROR_EXIT"), worktree: true },
			repoA.dir,
		);
		idA = retained.id;
		await manager.wait([idA]);
		const { baseDir } = worktreeBaseDir(repoA.dir);
		const wtPath = path.join(baseDir, idA);
		assert.ok(existsSync(wtPath), "retained worktree exists");
		assert.equal(await readFile(path.join(repoA.dir, "src", "a.txt"), "utf8"), "a\n", "root untouched by retention");

		// A running task in the SAME repository blocks discard and leaves the
		// retained worktree and the repository root untouched.
		const blocker = manager.spawn(
			{ ...spec("wt-discard-guard-b", "write", ["src/b.txt"], "WRITE_SRC_B SLOW"), worktree: true },
			repoA.dir,
		);
		blockerId = blocker.id;
		assert.equal(manager.get(blockerId)?.status, "running");
		assert.throws(() => manager.discardRetainedWorktree(idA), /same repository/);
		assert.ok(existsSync(wtPath), "retained worktree must stay while a same-repo task runs");
		assert.equal(await readFile(path.join(repoA.dir, "src", "a.txt"), "utf8"), "a\n", "root untouched while blocked");
		await manager.wait([blockerId]);

		// A running task in ANOTHER repository does not block discard.
		const other = manager.spawn(
			{ ...spec("wt-discard-guard-c", "write", ["src/b.txt"], "WRITE_SRC_B SLOW"), worktree: true },
			repoB.dir,
		);
		idB = other.id;
		assert.equal(manager.get(idB)?.status, "running");
		manager.discardRetainedWorktree(idA);
		assert.ok(!existsSync(wtPath), "worktree removed after the same-repo blocker settled");
		assert.ok(
			!manager.listRetainedWorktrees().some((view) => view.taskId === idA),
			"registry updated after discard",
		);
		assert.equal(await readFile(path.join(repoA.dir, "src", "a.txt"), "utf8"), "a\n", "root untouched by discard");
		await manager.wait([idB]);
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repoA, [idA, blockerId]);
		await cleanupRepo(repoB, [idB]);
	}
});

test("cleanup-failed retained integration is not reapplied and discard recovers it", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	let id = "";
	try {
		const started = manager.spawn(
			{ ...spec("wt-cf", "write", ["src/a.txt"], "WRITE_SRC_A SLOW_SHORT"), worktree: true },
			repo.dir,
		);
		id = started.id;
		const { baseDir } = worktreeBaseDir(repo.dir);
		const wtPath = path.join(baseDir, id);
		// Lock the worktree so `git worktree remove --force` fails at integration
		// cleanup -> cleanup-failed retained with rootIntegrated=true.
		execFileSync("git", ["worktree", "lock", wtPath], { cwd: repo.dir, stdio: "ignore" });
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		assert.equal(settled.worktree?.status, "cleanup-failed");
		assert.equal(await readFile(path.join(repo.dir, "src", "a.txt"), "utf8"), "A-from-worker\n", "root is integrated");
		const view = manager.getRetainedWorktree(id);
		assert.equal(view.rootIntegrated, true);
		assert.equal(view.retryable, false);
		assert.equal(view.patchAvailable, false);
		assert.throws(() => manager.retryRetainedWorktree(id), /not retryable/, "must not reapply an integrated patch");
		assert.ok(existsSync(wtPath), "worktree retained after cleanup failure");
		assertViewNoTempLeak(view);
		// Unlock and discard to recover.
		execFileSync("git", ["worktree", "unlock", wtPath], { cwd: repo.dir, stdio: "ignore" });
		manager.discardRetainedWorktree(id);
		assert.ok(
			!manager.listRetainedWorktrees().some((v) => v.taskId === id),
			"registry updated after discard",
		);
		assert.ok(!existsSync(wtPath), "worktree removed after discard");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [id]);
	}
});

test("discard removes the exact registered worktree and updates the registry without touching the root", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	let id = "";
	try {
		const started = manager.spawn(
			{ ...spec("wt-discard", "write", ["src/a.txt"], "WRITE_SRC_A ERROR_EXIT"), worktree: true },
			repo.dir,
		);
		id = started.id;
		await manager.wait([started.id]);
		const { baseDir } = worktreeBaseDir(repo.dir);
		const wtPath = path.join(baseDir, id);
		assert.ok(existsSync(wtPath), "retained worktree exists");
		manager.discardRetainedWorktree(id);
		assert.ok(
			!manager.listRetainedWorktrees().some((v) => v.taskId === id),
			"registry updated after discard",
		);
		assert.ok(!existsSync(wtPath), "worktree removed");
		assert.equal(await readFile(path.join(repo.dir, "src", "a.txt"), "utf8"), "a\n", "root untouched");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [id]);
	}
});

test("discard persists and retains with a redacted error on cleanup failure", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	let id = "";
	try {
		const started = manager.spawn(
			{ ...spec("wt-discard-fail", "write", ["src/a.txt"], "WRITE_SRC_A ERROR_EXIT"), worktree: true },
			repo.dir,
		);
		id = started.id;
		await manager.wait([started.id]);
		const { baseDir } = worktreeBaseDir(repo.dir);
		const wtPath = path.join(baseDir, id);
		execFileSync("git", ["worktree", "lock", wtPath], { cwd: repo.dir, stdio: "ignore" });
		const view = manager.discardRetainedWorktree(id);
		assert.ok(
			manager.listRetainedWorktrees().some((v) => v.taskId === id),
			"entry retained on failure",
		);
		assert.match(view.error ?? "", /git worktree remove failed/);
		assert.ok(existsSync(wtPath), "worktree still present after failed discard");
		assert.equal(await readFile(path.join(repo.dir, "src", "a.txt"), "utf8"), "a\n", "root untouched");
		assertViewNoTempLeak(view);
		// Unlock, then discard succeeds.
		execFileSync("git", ["worktree", "unlock", wtPath], { cwd: repo.dir, stdio: "ignore" });
		manager.discardRetainedWorktree(id);
		assert.ok(!manager.listRetainedWorktrees().some((v) => v.taskId === id));
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await cleanupRepo(repo, [id]);
	}
});

test("dispose/shutdown never auto-discards retained worktrees", async () => {
	const fake = await fakeWorker();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	let id = "";
	try {
		const started = manager.spawn(
			{ ...spec("wt-dispose-retain", "write", ["src/a.txt"], "WRITE_SRC_A ERROR_EXIT"), worktree: true },
			repo.dir,
		);
		id = started.id;
		await manager.wait([started.id]);
		const { baseDir } = worktreeBaseDir(repo.dir);
		const wtPath = path.join(baseDir, id);
		assert.equal(manager.listRetainedWorktrees().length, 1);
		assert.ok(existsSync(wtPath));
		await manager.dispose();
		// After shutdown the retained worktree is still listed and physically present.
		assert.equal(manager.listRetainedWorktrees().length, 1, "dispose must not auto-discard");
		assert.ok(existsSync(wtPath), "worktree must survive dispose");
	} finally {
		await fake.cleanup();
		await cleanupRepo(repo, [id]);
	}
});
