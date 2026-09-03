import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	captureGitFingerprint,
	FINGERPRINT_MAX_FILE_BYTES,
	hashPathWithoutFollowing,
	parsePorcelainStatusRecords,
	OpenCodeTaskManager,
} from "./manager.ts";
import { clearAmbientModelConfigEnv } from "./test-helpers.ts";
import { buildWorkerEnv } from "./worker-env.ts";

clearAmbientModelConfigEnv();

async function fakeOpenCode() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "fake-opencode-"));
	const script = path.join(dir, "opencode.mjs");
	await writeFile(
		script,
		`
const prompt = process.argv.at(-1) || "";
const delay = prompt.includes("queue-block") ? 30_000 : prompt.includes("slow") ? 500 : 20;
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text: "FAKE_OK" } }) + "\\n");
}, delay);
`,
	);
	return {
		binary: process.execPath,
		binaryArgs: [script],
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

async function fakeEchoArgs() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "fake-echo-"));
	const script = path.join(dir, "echo-args.mjs");
	await writeFile(
		script,
		`
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text: JSON.stringify(args) } }) + "\\n");
`,
	);
	return {
		binary: process.execPath,
		binaryArgs: [script],
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

async function fakeOpenCodeWithUsage() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "fake-usage-"));
	const script = path.join(dir, "usage.mjs");
	await writeFile(
		script,
		`
process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text: "done" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "step_finish", part: { type: "step-finish", reason: "stop", tokens: { total: 250, input: 100, output: 50, reasoning: 70, cache: { write: 20, read: 10 } }, cost: 0.003 } }) + "\\n");
`,
	);
	return {
		binary: process.execPath,
		binaryArgs: [script],
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

async function fakeCollie() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "fake-collie-"));
	const script = path.join(dir, "collie.mjs");
	await writeFile(
		script,
		`
const args = process.argv.slice(2);
const report = { summary: "collie done", files: ["src/collie.ts"], findings: ["ok"], unresolved: [] };
process.stderr.write(JSON.stringify({ type: "progress", message: "streaming", args }) + "\\n");
process.stdout.write(JSON.stringify({ answer: JSON.stringify(report), usage: { input: 11, output: 7, total: 18, cost: 0.004 } }) + "\\n");
`,
	);
	return {
		binary: process.execPath,
		binaryArgs: [script],
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

async function fakePiMessageEnd() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "fake-pi-msgend-"));
	const script = path.join(dir, "msgend.mjs");
	await writeFile(
		script,
		`
const report = { summary: "pi done", files: ["x.ts"], findings: ["ok"], unresolved: [] };
process.stdout.write(JSON.stringify({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text: JSON.stringify(report) }],
		usage: { input: 300, output: 120, cacheRead: 40, cacheWrite: 20, reasoning: 60, totalTokens: 420, cost: { total: 0.02 } },
	},
}) + "\\n");
`,
	);
	return {
		binary: process.execPath,
		binaryArgs: [script],
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

async function fakeOpenCodeWithReport() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "fake-report-"));
	const script = path.join(dir, "report.mjs");
	await writeFile(
		script,
		`
const fence = [96, 96, 96].map((c) => String.fromCharCode(c)).join("");
const report = { summary: "done", files: ["a.ts"], findings: ["ok"], unresolved: [] };
process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text: "Working on it..." } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text: fence + "json\\n" + JSON.stringify(report) + "\\n" + fence } }) + "\\n");
`,
	);
	return {
		binary: process.execPath,
		binaryArgs: [script],
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

test("worker environment defaults to runtime variables and requires explicit additions", () => {
	const env = buildWorkerEnv({
		PATH: "path-value",
		HOME: "home-value",
		OPENCODE_CONFIG_CONTENT: "config-value",
		PROVIDER_API_KEY: "secret-value",
		PI_ORCH_WORKER_ENV_ALLOWLIST: "EXTRA_RUNTIME, PROVIDER_API_KEY",
		EXTRA_RUNTIME: "extra-value",
	});
	assert.equal(env.PATH, "path-value");
	assert.equal(env.HOME, "home-value");
	assert.equal(env.OPENCODE_CONFIG_CONTENT, "config-value");
	assert.equal(env.EXTRA_RUNTIME, "extra-value");
	assert.equal(env.PROVIDER_API_KEY, "secret-value");
	assert.equal(env.UNSET, undefined);
});

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

// The fingerprint baseline must exercise non-ASCII (Japanese) path segments,
// matching the "Japanese path case required for fingerprint" requirement.
async function fakeGitRepo() {
	const base = await mkdtemp(path.join(os.tmpdir(), "テスト-"));
	const dir = path.join(base, "リポジトリ");
	await mkdir(dir, { recursive: true });
	const git = (args: string[]) =>
		execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
	git(["init", "-q"]);
	await writeFile(path.join(dir, "base.txt"), "base\n", "utf8");
	git(["add", "base.txt"]);
	git(["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "base"]);
	return {
		dir,
		git,
		cleanup: () => rm(base, { recursive: true, force: true }),
	};
}

test("GitFingerprint requires HEAD identity and observes a same-commit branch switch", async () => {
	const repo = await fakeGitRepo();
	try {
		const before = captureGitFingerprint(repo.dir);
		assert.ok(before);
		assert.match(before.headOid, /^[0-9a-f]{40}$/);
		assert.ok(before.headRef);
		repo.git(["branch", "same-commit"]);
		repo.git(["checkout", "-q", "same-commit"]);
		const after = captureGitFingerprint(repo.dir);
		assert.ok(after);
		assert.equal(after.headOid, before.headOid, "the test branch intentionally points at the same commit");
		assert.notEqual(after.headRef, before.headRef, "the symbolic HEAD identity must still change");
	} finally {
		await repo.cleanup();
	}
});

// A helper-level digest over one path, used by the no-follow tests below.
function digestPathWithoutFollowing(file: string): { outcome: ReturnType<typeof hashPathWithoutFollowing>; digest: string } {
	const hash = createHash("sha256");
	const outcome = hashPathWithoutFollowing(hash, file);
	return { outcome, digest: hash.digest("hex") };
}

test("hashPathWithoutFollowing reads exact regular bytes and fails closed on oversize paths", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "fp-path-"));
	try {
		const file = path.join(dir, "regular.txt");
		writeFileSync(file, "fingerprint content\n");
		const first = digestPathWithoutFollowing(file);
		assert.ok(first.outcome.ok);
		assert.equal(first.outcome.kind, "file");
		assert.equal(digestPathWithoutFollowing(file).digest, first.digest);
		writeFileSync(file, "fingerprint content 2\n");
		assert.notEqual(digestPathWithoutFollowing(file).digest, first.digest);
		// A file larger than one bounded-read chunk (reads are capped at 1 MiB)
		// crosses the chunk boundary with a full chunk plus a partial tail and
		// must still settle to the exact same digest as its own bytes.
		const chunked = path.join(dir, "chunked.bin");
		const chunkedBytes = Buffer.concat([Buffer.alloc(1024 * 1024, 0x61), Buffer.from("tail-bytes")]);
		writeFileSync(chunked, chunkedBytes);
		const chunkedFirst = digestPathWithoutFollowing(chunked);
		assert.ok(chunkedFirst.outcome.ok);
		assert.equal(chunkedFirst.outcome.kind, "file");
		assert.equal(digestPathWithoutFollowing(chunked).digest, chunkedFirst.digest);
		writeFileSync(chunked, Buffer.concat([chunkedBytes, Buffer.from("!")]));
		assert.notEqual(digestPathWithoutFollowing(chunked).digest, chunkedFirst.digest);
		// An over-cap file fails closed before any of its content is read.
		const big = path.join(dir, "big.bin");
		writeFileSync(big, "x");
		truncateSync(big, FINGERPRINT_MAX_FILE_BYTES + 1);
		assert.equal(hashPathWithoutFollowing(createHash("sha256"), big).ok, false);
		// A path that is absent from the start is a stable Git-visible state
		// (deleted dirty paths and rename sources), not an instability.
		const missing = digestPathWithoutFollowing(path.join(dir, "absent.txt"));
		assert.ok(missing.outcome.ok);
		assert.equal(missing.outcome.kind, "missing");
		assert.equal(digestPathWithoutFollowing(path.join(dir, "elsewhere.txt")).digest, missing.digest);
		// A directory is hashed from lstat metadata only and never opened.
		const directory = digestPathWithoutFollowing(dir);
		assert.ok(directory.outcome.ok);
		assert.equal(directory.outcome.kind, "special");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("hashPathWithoutFollowing hashes the link itself and never its target", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "fp-link-"));
	const targetDir = path.join(dir, "target-dir");
	const otherDir = path.join(dir, "other-dir");
	try {
		mkdirSync(targetDir, { recursive: true });
		mkdirSync(otherDir, { recursive: true });
		writeFileSync(path.join(targetDir, "inside.bin"), "target content");
		// The link target holds an over-cap file: following it would blow the
		// fingerprint size cap, so a settled link hash proves it is never read.
		const big = path.join(targetDir, "large.bin");
		writeFileSync(big, "x");
		truncateSync(big, FINGERPRINT_MAX_FILE_BYTES + 1);
		const link = path.join(dir, "link");
		const linkType = process.platform === "win32" ? "junction" : "dir";
		symlinkSync(targetDir, link, linkType);
		const digestLink = () => {
			const result = digestPathWithoutFollowing(link);
			assert.ok(result.outcome.ok);
			assert.equal(result.outcome.kind, "symlink");
			return result.digest;
		};
		const before = digestLink();
		// Mutating bytes behind the link never changes the link's own hash.
		writeFileSync(path.join(targetDir, "inside.bin"), "target content changed");
		assert.equal(digestLink(), before);
		// Pointing the link at a different target does.
		unlinkSync(link);
		symlinkSync(otherDir, link, linkType);
		assert.notEqual(digestLink(), before);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// FIFOs cannot exist on Windows, so this regression only registers on platforms
// where mkfifo can run; it never skips at runtime.
if (process.platform !== "win32") {
	test("hashPathWithoutFollowing settles FIFOs from lstat metadata instead of opening them", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "fp-fifo-"));
		try {
			const fifo = path.join(dir, "pipe");
			execFileSync("mkfifo", [fifo]);
			const digestFifo = () => {
				const result = digestPathWithoutFollowing(fifo);
				assert.ok(result.outcome.ok);
				assert.equal(result.outcome.kind, "special");
				return result.digest;
			};
			const before = digestFifo();
			assert.equal(digestFifo(), before);
			// Recreating the FIFO yields a new inode, which the metadata hash sees.
			unlinkSync(fifo);
			execFileSync("mkfifo", [fifo]);
			assert.notEqual(digestFifo(), before);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

// Windows without Developer Mode/administrator rights forbids creating
// symlinks (EPERM), so probe once whether this process can create a real file
// symlink at all; the fingerprint-level link regression only registers where
// the platform can produce one and never skips at runtime.
function canCreateFileSymlinks(): boolean {
	const dir = mkdtempSync(path.join(os.tmpdir(), "fp-symlink-probe-"));
	try {
		const target = path.join(dir, "target.txt");
		writeFileSync(target, "probe");
		symlinkSync(target, path.join(dir, "link"), "file");
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

if (canCreateFileSymlinks()) {
	test("captureGitFingerprint fingerprints an untracked symlink without following its target", async () => {
		const repo = await fakeGitRepo();
		const external = await mkdtemp(path.join(os.tmpdir(), "fp-external-"));
		try {
			// The target is an oversized external file: following it would exceed
			// the fingerprint cap, so a settled fingerprint proves it stays unread.
			const bigTarget = path.join(external, "large.bin");
			await writeFile(bigTarget, "x");
			await truncate(bigTarget, FINGERPRINT_MAX_FILE_BYTES + 1);
			const link = path.join(repo.dir, "link.bin");
			symlinkSync(bigTarget, link);
			const before = captureGitFingerprint(repo.dir);
			assert.ok(before);
			const linkHash = before.pathHashes.get("link.bin");
			assert.ok(linkHash, "the untracked link must join the fingerprint");
			// Two captures settle to the same state even though the target is huge.
			const again = captureGitFingerprint(repo.dir);
			assert.ok(again);
			assert.equal(again.hash, before.hash);
			// Changing only the external target bytes never changes the fingerprint.
			writeFileSync(bigTarget, "y", { flag: "r+" });
			const afterTargetChange = captureGitFingerprint(repo.dir);
			assert.ok(afterTargetChange);
			assert.equal(afterTargetChange.hash, before.hash);
			// Retargeting the link itself does change the fingerprint.
			const smallTarget = path.join(external, "small.bin");
			await writeFile(smallTarget, "small\n");
			unlinkSync(link);
			symlinkSync(smallTarget, link);
			const afterRetarget = captureGitFingerprint(repo.dir);
			assert.ok(afterRetarget);
			assert.notEqual(afterRetarget.hash, before.hash);
			assert.notEqual(afterRetarget.pathHashes.get("link.bin"), linkHash);
		} finally {
			await repo.cleanup();
			await rm(external, { recursive: true, force: true });
		}
	});
}

test("captureGitFingerprint fails closed for an oversized untracked path", async () => {
	const repo = await fakeGitRepo();
	try {
		const big = path.join(repo.dir, "big.bin");
		await writeFile(big, "x");
		await truncate(big, FINGERPRINT_MAX_FILE_BYTES + 1);
		assert.equal(captureGitFingerprint(repo.dir), undefined);
	} finally {
		await repo.cleanup();
	}
});

test("captureGitFingerprint fails closed for an oversized tracked dirty path", async () => {
	const repo = await fakeGitRepo();
	try {
		// base.txt is tracked and clean, so it only reaches the hasher through
		// the status-driven per-path hashes; the cap must fail the capture there.
		await truncate(path.join(repo.dir, "base.txt"), FINGERPRINT_MAX_FILE_BYTES + 1);
		assert.equal(captureGitFingerprint(repo.dir), undefined);
	} finally {
		await repo.cleanup();
	}
});

test("captureGitFingerprint distinguishes dirty regular content and settled deletions", async () => {
	const repo = await fakeGitRepo();
	try {
		const dirty = path.join(repo.dir, "dirty.txt");
		await writeFile(dirty, "one\n");
		const before = captureGitFingerprint(repo.dir);
		assert.ok(before);
		const dirtyHash = before.pathHashes.get("dirty.txt");
		assert.ok(dirtyHash);
		await writeFile(dirty, "two\n");
		const after = captureGitFingerprint(repo.dir);
		assert.ok(after);
		assert.notEqual(after.pathHashes.get("dirty.txt"), dirtyHash);
		assert.notEqual(after.hash, before.hash);
		// A Git-reported worktree deletion is a stable fingerprint state (the
		// in-scope git mv rename flow depends on it), not an instability.
		await rm(path.join(repo.dir, "base.txt"));
		const deleted = captureGitFingerprint(repo.dir);
		assert.ok(deleted);
		assert.ok(deleted.pathHashes.get("base.txt"), "a Git-reported deletion must still join the path hashes");
		const repeat = captureGitFingerprint(repo.dir);
		assert.ok(repeat);
		assert.equal(repeat.hash, deleted.hash);
	} finally {
		await repo.cleanup();
	}
});

test("porcelain -z parser pairs rename records and preserves plain, untracked, spaced, and Unicode paths", () => {
	// Plain status records and untracked entries keep their XY and verbatim path.
	assert.deepEqual(parsePorcelainStatusRecords(["M  a.ts", " D b.ts", "?? 新しい c.txt"]), [
		{ path: "a.ts", status: "M " },
		{ path: "b.ts", status: " D" },
		{ path: "新しい c.txt", status: "??" },
	]);
	// Rename records are positional pairs: the bare next record is the old path,
	// consumed whole (never slice(3)-ed), and both paths share the record's XY.
	assert.deepEqual(parsePorcelainStatusRecords(["R  src/新しい場所/renamed.txt", "src/古い 場所/old.txt"]), [
		{ path: "src/新しい場所/renamed.txt", status: "R " },
		{ path: "src/古い 場所/old.txt", status: "R " },
	]);
	// Copy records consume the source record the same way.
	assert.deepEqual(parsePorcelainStatusRecords(["C  copies/コピー.txt", "コピー 元.txt"]), [
		{ path: "copies/コピー.txt", status: "C " },
		{ path: "コピー 元.txt", status: "C " },
	]);
	// R/C in either the index or the worktree column triggers source consumption.
	assert.deepEqual(parsePorcelainStatusRecords(["RM m.txt", "o.txt"]), [
		{ path: "m.txt", status: "RM" },
		{ path: "o.txt", status: "RM" },
	]);
	assert.deepEqual(parsePorcelainStatusRecords([" R w.txt", "o.txt"]), [
		{ path: "w.txt", status: " R" },
		{ path: "o.txt", status: " R" },
	]);
	// A source record is consumed positionally, never re-parsed as its own
	// status record; a trailing source-less rename degrades to the new path.
	assert.deepEqual(parsePorcelainStatusRecords(["R  b.txt", "?? decoy"]), [
		{ path: "b.txt", status: "R " },
		{ path: "?? decoy", status: "R " },
	]);
	assert.deepEqual(parsePorcelainStatusRecords(["R  only.txt"]), [{ path: "only.txt", status: "R " }]);
});

async function fakeMutatingOpenCode(mutation = `writeFileSync("mutated.txt", "changed\\n", "utf8");`) {
	const dir = await mkdtemp(path.join(os.tmpdir(), "fake-mutate-"));
	const script = path.join(dir, "mutate.mjs");
	await writeFile(
		script,
		`
const { writeFileSync } = await import("node:fs");
const { execFileSync } = await import("node:child_process");
${mutation}
process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text: "MUTATED" } }) + "\\n");
`,
	);
	return {
		binary: process.execPath,
		binaryArgs: [script],
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

async function fakeEchoEnv() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "fake-env-"));
	const script = path.join(dir, "env.mjs");
	await writeFile(
		script,
		`
const value = process.env.OPENCODE_CONFIG_CONTENT ?? "";
process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text: value } }) + "\\n");
`,
	);
	return {
		binary: process.execPath,
		binaryArgs: [script],
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

async function fakeEchoIsolationEnv() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "fake-isolation-env-"));
	const script = path.join(dir, "env.mjs");
	await writeFile(
		script,
		`
const result = {
  configDir: process.env.OPENCODE_CONFIG_DIR,
  xdgConfigHome: process.env.XDG_CONFIG_HOME,
  dataHome: process.env.XDG_DATA_HOME,
  disableProject: process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
};
process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text: JSON.stringify(result) } }) + "\\n");
`,
	);
	return {
		binary: process.execPath,
		binaryArgs: [script],
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

test("manager runs read-only tasks concurrently but rejects concurrent direct writes with worktree guidance", async () => {
	const fake = await fakeOpenCode();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	try {
		const readA = manager.spawn(spec("read-a", "read_only", ["src"]), process.cwd());
		const readB = manager.spawn(spec("read-b", "read_only", ["src"]), process.cwd());
		assert.equal(manager.runningCount(), 2);
		const reads = await manager.wait([readA.id, readB.id]);
		assert.deepEqual(reads.map((item) => item.status), ["done", "done"]);
		assert.ok(reads.every((item) => item.output.includes("FAKE_OK")));

		// The first direct (non-isolated) write is accepted while no other write runs.
		const writeA = manager.spawn(spec("write-a", "write", ["src/a.ts"], "slow write a"), process.cwd());
		assert.equal(manager.runningCount(), 1);
		// A concurrent direct write is now rejected even when scopes are disjoint,
		// with guidance to opt into worktree isolation.
		assert.throws(
			() => manager.spawn(spec("write-b", "write", ["src/b.ts"], "slow write b"), process.cwd()),
			/worktree=true/,
		);
		// Overlap checks are retained: a concurrent write whose scope overlaps the
		// running write is also refused.
		assert.throws(
			() => manager.spawn(spec("write-parent", "write", ["src"]), process.cwd()),
			/worktree=true|conflicts/,
		);
		await manager.cancel([writeA.id]);
		assert.equal(manager.get(writeA.id)?.status, "cancelled");
	} finally {
		await manager.dispose();
		await fake.cleanup();
	}
});

test("cancellation after worker exit prevents queued worktree integration", async () => {
	const fake = await fakeOpenCode();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({ binary: fake.binary, binaryArgs: fake.binaryArgs, timeoutMs: 2_000 });
	try {
		const first = manager.spawn({ ...spec("queue-first", "write", ["src/a"], "queue-block"), worktree: true }, repo.dir);
		const queued = manager.spawn({ ...spec("queue-cancel", "write", ["src/b"], "quick"), worktree: true }, repo.dir);
		for (let attempt = 0; attempt < 40 && !manager.get(queued.id)?.output.includes("FAKE_OK"); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.equal(manager.get(queued.id)?.status, "running", "worker must be exited while finalization waits in the queue");
		const [cancelled] = await manager.cancel([queued.id]);
		assert.equal(cancelled.status, "cancelled");
		assert.equal(cancelled.worktree?.status, "retained");
		const [cancelledFirst] = await manager.cancel([first.id]);
		assert.equal(cancelledFirst.status, "cancelled");
		assert.equal(cancelledFirst.worktree?.status, "retained");
		assert.equal(await readFile(path.join(repo.dir, "base.txt"), "utf8"), "base\n");
		manager.discardRetainedWorktree(queued.id);
		manager.discardRetainedWorktree(first.id);
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await repo.cleanup();
	}
});

test("retained worktree view redacts a repo-root scope to '.' and keeps child scopes repo-relative", async () => {
	const fake = await fakeOpenCode();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({ binary: fake.binary, binaryArgs: fake.binaryArgs, timeoutMs: 2_000 });
	try {
		const started = manager.spawn({ ...spec("root-scope", "write", [".", "base.txt"], "quick"), worktree: true }, repo.dir);
		const [cancelled] = await manager.cancel([started.id]);
		assert.equal(cancelled.status, "cancelled");
		assert.equal(cancelled.worktree?.status, "retained");
		const view = manager.getRetainedWorktree(started.id);
		assert.deepEqual(view.scopes, [".", "base.txt"], "repo-root scope is redacted to '.' and child scopes stay repo-relative");
		for (const scope of view.scopes) {
			assert.ok(!path.isAbsolute(scope), "no scope may expose an absolute repository path");
			assert.ok(!scope.includes(os.tmpdir()), "no scope may leak the temp or repo layout");
		}
		manager.discardRetainedWorktree(started.id);
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await repo.cleanup();
	}
});

test("adapter launch exceptions clean up prepared worktrees and poison the batch", async () => {
	const repo = await fakeGitRepo();
	let cleanupCalls = 0;
	const manager = new OpenCodeTaskManager({ timeoutMs: 2_000 });
	const adapters = (manager as any).backends;
	adapters.opencode = {
		id: "opencode",
		displayName: "fake",
		binary: "unused",
		binaryArgs: [],
		prepare: () => ({ agentName: "fake-agent", activity: [] }),
		buildArgs: () => { throw new Error("adapter build failed"); },
		buildEnv: (env: NodeJS.ProcessEnv) => env,
		cleanupAgent: () => { cleanupCalls++; },
		decodeStdoutLine: () => ({ activity: [] }),
		decodeStderrChunk: (text: string) => ({ text, activity: [] }),
		normalizeExitReport: (report: unknown) => report,
	};
	try {
		assert.throws(
			() => manager.spawn({ ...spec("adapter-failure", "write", ["src/a"]), worktree: true }, repo.dir),
			/adapter build failed/,
		);
		assert.equal(cleanupCalls, 1);
		assert.equal(manager.list().length, 0, "successfully cleaned launch failures do not remain as task history");
		assert.equal(repo.git(["worktree", "list", "--porcelain"]).toString("utf8").trim().split("\n\n").length, 1);
	} finally {
		await manager.dispose();
		await repo.cleanup();
	}
});

test("manager rejects worktree=true for read_only mode", async () => {
	const manager = new OpenCodeTaskManager();
	try {
		assert.throws(
			() => manager.spawn({ ...spec("wt-readonly", "read_only", ["src"]), worktree: true }, process.cwd()),
			/Worktree isolation \(worktree=true\) requires mode write/,
		);
	} finally {
		await manager.dispose();
	}
});

test("manager rejects worktree=true outside a Git repository root", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pi-opencode-nongit-wt-"));
	try {
		const manager = new OpenCodeTaskManager();
		try {
			assert.throws(
				() => manager.spawn({ ...spec("wt-nongit", "write", ["src"]), worktree: true }, dir),
				/Worktree isolation requires a Git repository root/,
			);
		} finally {
			await manager.dispose();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("manager enforces the global four-worker cap", async () => {
	const fake = await fakeOpenCode();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	try {
		const running = Array.from({ length: 4 }, (_, index) =>
			manager.spawn(spec(`slow-${index}`, "read_only", ["src"], `slow ${index}`), process.cwd()),
		);
		assert.equal(manager.runningCount(), 4);
		assert.throws(
			() => manager.spawn(spec("fifth", "read_only", ["src"]), process.cwd()),
			/concurrency limit/,
		);
		await manager.cancel(running.map((item) => item.id));
	} finally {
		await manager.dispose();
		await fake.cleanup();
	}
});

test("manager applies model changes to future tasks", async () => {
	const manager = new OpenCodeTaskManager();
	try {
		manager.setModelSetting("worker", "example/default");
		manager.setModelSetting("implementer", "example/implementer");
		manager.setModelSetting("reviewer", "example/reviewer");
		assert.deepEqual(manager.configuration().model, "example/default");
		assert.deepEqual(manager.configuration().profiles, {
			implementer: "example/implementer",
			reviewer: "example/reviewer",
		});
	} finally {
		await manager.dispose();
	}
});

test("manager canonicalizes legacy opencode: prefixed models across env, options, setter, and profile values", async () => {
	const originalModel = process.env.PI_OPENCODE_MODEL;
	const originalImpl = process.env.PI_OPENCODE_PROFILE_IMPLEMENTER;
	const originalRev = process.env.PI_OPENCODE_PROFILE_REVIEWER;
	const originalTester = process.env.PI_OPENCODE_PROFILE_TESTER;
	process.env.PI_OPENCODE_MODEL = "opencode:env/single";
	process.env.PI_OPENCODE_PROFILE_IMPLEMENTER = "opencode:env/impl";
	process.env.PI_OPENCODE_PROFILE_REVIEWER = "opencode:opencode:env/rev";
	process.env.PI_OPENCODE_PROFILE_TESTER = "opencode:env/tester";
	try {
		// Environment-sourced values are canonicalized (single and repeated prefix).
		const fromEnv = new OpenCodeTaskManager();
		try {
			assert.equal(fromEnv.configuration().model, "env/single");
			assert.deepEqual(fromEnv.configuration().profiles, {
				implementer: "env/impl",
				reviewer: "env/rev",
			});
			assert.equal(fromEnv.configuration().testerProfile, "env/tester");
		} finally {
			await fromEnv.dispose();
		}

		// Explicit options canonicalize too and take precedence over env.
		const fromOptions = new OpenCodeTaskManager({
			model: "opencode:opt/model",
			testerModel: "opencode:opt/tester",
		});
		try {
			assert.equal(fromOptions.configuration().model, "opt/model");
			assert.equal(fromOptions.configuration().testerProfile, "opt/tester");
		} finally {
			await fromOptions.dispose();
		}

		// The setter canonicalizes single and repeated prefixes before storage.
		const setters = new OpenCodeTaskManager();
		try {
			setters.setModelSetting("worker", "opencode:set/worker");
			setters.setModelSetting("implementer", "opencode:opencode:set/imp");
			setters.setModelSetting("reviewer", "opencode:set/rev");
			setters.setModelSetting("tester", "opencode:set/tester");
			assert.equal(setters.configuration().model, "set/worker");
			assert.deepEqual(setters.configuration().profiles, {
				implementer: "set/imp",
				reviewer: "set/rev",
			});
			assert.equal(setters.configuration().testerProfile, "set/tester");
			// A setter that normalizes away entirely is rejected.
			assert.throws(() => setters.setModelSetting("worker", "opencode:   "), /must not be empty/);
		} finally {
			await setters.dispose();
		}
	} finally {
		if (originalModel === undefined) delete process.env.PI_OPENCODE_MODEL;
		else process.env.PI_OPENCODE_MODEL = originalModel;
		if (originalImpl === undefined) delete process.env.PI_OPENCODE_PROFILE_IMPLEMENTER;
		else process.env.PI_OPENCODE_PROFILE_IMPLEMENTER = originalImpl;
		if (originalRev === undefined) delete process.env.PI_OPENCODE_PROFILE_REVIEWER;
		else process.env.PI_OPENCODE_PROFILE_REVIEWER = originalRev;
		if (originalTester === undefined) delete process.env.PI_OPENCODE_PROFILE_TESTER;
		else process.env.PI_OPENCODE_PROFILE_TESTER = originalTester;
	}
});

test("manager runs an opt-in Collie worker only in an isolated implementer worktree", async () => {
	const fake = await fakeCollie();
	const repo = await fakeGitRepo();
	const original = process.env.PI_ORCH_ENABLE_COLLIE;
	process.env.PI_ORCH_ENABLE_COLLIE = "1";
	const manager = new OpenCodeTaskManager({
		collieBinary: fake.binary,
		collieBinaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	try {
		const started = manager.spawn({
			...spec("collie-worker", "write", ["src/collie.ts"]),
			model: "collie::provider/model-name",
			role: "implementer",
			worktree: true,
		}, repo.dir);
		assert.equal(started.backend, "collie");
		assert.equal(started.model, "provider/model-name");
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		assert.equal(settled.report?.summary, "collie done");
		assert.deepEqual(settled.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18, cost: 0.004 });
		assert.ok(settled.activity.includes("progress: streaming"));
		const args = (JSON.parse(settled.stderr.trim()) as { args: string[] }).args;
		assert.equal(args[0], "run");
		assert.match(args[1] ?? "", /Task name: collie-worker/);
		assert.equal(args[args.indexOf("--provider") + 1], "provider");
		assert.equal(args[args.indexOf("--model") + 1], "model-name");
		assert.equal(args[args.indexOf("--mode") + 1], "auto");
		assert.equal(args.at(-2), "--json");
		assert.equal(args.at(-1), "--stream-json");
	} finally {
		await manager.dispose();
		if (original === undefined) delete process.env.PI_ORCH_ENABLE_COLLIE;
		else process.env.PI_ORCH_ENABLE_COLLIE = original;
		await fake.cleanup();
		await repo.cleanup();
	}
});

test("manager rejects disabled and unsafe Collie routes before creating a task", async () => {
	const manager = new OpenCodeTaskManager({ collieBinary: "must-not-launch" });
	try {
		const base = { ...spec("collie-gate", "write", ["src/a.ts"]), model: "collie::provider/model", role: "implementer" as const, worktree: true };
		const original = process.env.PI_ORCH_ENABLE_COLLIE;
		delete process.env.PI_ORCH_ENABLE_COLLIE;
		try {
			assert.throws(() => manager.spawn(base, process.cwd()), /Collie backend is disabled/);
			assert.equal(manager.list().length, 0);
			process.env.PI_ORCH_ENABLE_COLLIE = "1";
			assert.throws(() => manager.spawn({ ...base, worktree: false }, process.cwd()), /worktree=true/);
			assert.throws(() => manager.spawn({ ...base, mode: "read_only", role: "tester", worktree: false }, process.cwd()), /role=implementer/);
			assert.throws(
				() => manager.spawn({ ...base, model: "collie::model-without-slash" }, process.cwd()),
				/Collie model must use provider\/model format/,
			);
			assert.equal(manager.list().length, 0);
		} finally {
			if (original === undefined) delete process.env.PI_ORCH_ENABLE_COLLIE;
			else process.env.PI_ORCH_ENABLE_COLLIE = original;
		}
	} finally {
		await manager.dispose();
	}
});

test("manager can bypass OpenCode and run a Pi-backed worker", async () => {
	const fake = await fakeOpenCode();
	const manager = new OpenCodeTaskManager({
		piBinary: fake.binary,
		piBinaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	try {
		manager.setModelSetting("worker", "pi::anthropic/example-claude");
		const started = manager.spawn(spec("pi-worker", "read_only", ["src"]), process.cwd());
		assert.equal(started.backend, "pi");
		assert.equal(started.model, "anthropic/example-claude");
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		assert.match(settled.output, /FAKE_OK/);
	} finally {
		await manager.dispose();
		await fake.cleanup();
	}
});

test("manager applies default medium thinking to OpenCode --variant", async () => {
	const fake = await fakeEchoArgs();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	try {
		assert.equal(manager.configuration().thinkingLevel, "medium");
		const started = manager.spawn(spec("echo", "read_only", ["src"]), process.cwd());
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		const args = JSON.parse(settled.output.trim());
		const variantIdx = args.indexOf("--variant");
		assert.ok(variantIdx >= 0, "--variant not found in args");
		assert.equal(args[variantIdx + 1], "medium");
	} finally {
		await manager.dispose();
		await fake.cleanup();
	}
});

test("manager applies spec thinking override to Pi --thinking", async () => {
	const fake = await fakeEchoArgs();
	const manager = new OpenCodeTaskManager({
		piBinary: fake.binary,
		piBinaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	try {
		manager.setModelSetting("worker", "pi::anthropic/example");
		const started = manager.spawn(
			{ ...spec("pi-echo", "read_only", ["src"]), thinking: "low" },
			process.cwd(),
		);
		assert.equal(started.backend, "pi");
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		const args = JSON.parse(settled.output.trim());
		const thinkingIdx = args.indexOf("--thinking");
		assert.ok(thinkingIdx >= 0, "--thinking not found in args");
		assert.equal(args[thinkingIdx + 1], "low");
		const modeIdx = args.indexOf("--mode");
		assert.ok(modeIdx >= 0, "--mode not found in Pi args");
		assert.equal(args[modeIdx + 1], "json");
		assert.equal(args.indexOf("--print"), -1, "--print must no longer be used");
		assert.ok(args.includes("--no-session"), "--no-session preserved");
		assert.ok(args.includes("--no-extensions"), "--no-extensions preserved");
	} finally {
		await manager.dispose();
		await fake.cleanup();
	}
});

test("manager reads PI_OPENCODE_THINKING for default thinking level", async () => {
	const fake = await fakeEchoArgs();
	const original = process.env.PI_OPENCODE_THINKING;
	process.env.PI_OPENCODE_THINKING = "high";
	try {
		const manager = new OpenCodeTaskManager({
			binary: fake.binary,
			binaryArgs: fake.binaryArgs,
			timeoutMs: 2_000,
		});
		try {
			assert.equal(manager.configuration().thinkingLevel, "high");
			const started = manager.spawn(spec("echo", "read_only", ["src"]), process.cwd());
			const [settled] = await manager.wait([started.id]);
			const args = JSON.parse(settled.output.trim());
			assert.equal(args[args.indexOf("--variant") + 1], "high");
		} finally {
			await manager.dispose();
		}
	} finally {
		if (original === undefined) delete process.env.PI_OPENCODE_THINKING;
		else process.env.PI_OPENCODE_THINKING = original;
		await fake.cleanup();
	}
});

test("manager extracts token usage from OpenCode step-finish events", async () => {
	const fake = await fakeOpenCodeWithUsage();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	try {
		const started = manager.spawn(spec("usage", "read_only", ["src"]), process.cwd());
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		assert.deepEqual(settled.usage, {
			inputTokens: 100,
			outputTokens: 50,
			totalTokens: 250,
			reasoningTokens: 70,
			cacheReadTokens: 10,
			cacheWriteTokens: 20,
			cost: 0.003,
		});
	} finally {
		await manager.dispose();
		await fake.cleanup();
	}
});

test("manager parses structured worker report at settlement", async () => {
	const fake = await fakeOpenCodeWithReport();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	try {
		const started = manager.spawn(spec("report", "read_only", ["src"]), process.cwd());
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		assert.ok(settled.report, "report should be set at settlement");
		assert.equal(settled.report?.summary, "done");
		assert.deepEqual(settled.report?.files, ["a.ts"]);
		assert.deepEqual(settled.report?.findings, ["ok"]);
		assert.deepEqual(settled.report?.unresolved, []);
	} finally {
		await manager.dispose();
		await fake.cleanup();
	}
});

test("manager provides bounded fallback report when output is not JSON", async () => {
	const fake = await fakeOpenCode();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	try {
		const started = manager.spawn(spec("plain", "read_only", ["src"]), process.cwd());
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		assert.ok(settled.report, "fallback report should still be set");
		assert.ok(settled.report!.unresolved.length > 0);
		assert.ok(settled.report!.summary.includes("fallback"));
	} finally {
		await manager.dispose();
		await fake.cleanup();
	}
});

test("manager captures Pi JSON message_end report output and usage", async () => {
	const fake = await fakePiMessageEnd();
	const manager = new OpenCodeTaskManager({
		piBinary: fake.binary,
		piBinaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	try {
		manager.setModelSetting("worker", "pi::anthropic/example");
		const started = manager.spawn(spec("pi-msgend", "read_only", ["src"]), process.cwd());
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		assert.match(settled.output, /pi done/);
		assert.deepEqual(settled.usage, {
			inputTokens: 300,
			outputTokens: 120,
			totalTokens: 420,
			reasoningTokens: 60,
			cacheReadTokens: 40,
			cacheWriteTokens: 20,
			cost: 0.02,
		});
		assert.equal(settled.report?.summary, "pi done");
		assert.deepEqual(settled.report?.files, ["x.ts"]);
		assert.deepEqual(settled.report?.findings, ["ok"]);
		assert.deepEqual(settled.report?.unresolved, []);
	} finally {
		await manager.dispose();
		await fake.cleanup();
	}
});

test("manager passes --agent with a generated definition file to OpenCode workers", async () => {
	const fake = await fakeEchoArgs();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	try {
		const started = manager.spawn(spec("agent-probe", "write", ["src"]), process.cwd());
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		const args = JSON.parse(settled.output.trim());
		const agentIdx = args.indexOf("--agent");
		assert.ok(agentIdx >= 0, "--agent not passed to OpenCode worker");
		const agentName = args[agentIdx + 1];
		assert.ok(typeof agentName === "string" && agentName.startsWith("pi-orch-"), "agent name must start with pi-orch-");
		// OpenCode resolves agents from ~/.config/opencode/agent/<name>.md
		const agentFile = path.join(os.homedir(), ".config", "opencode", "agent", `${agentName}.md`);
		// close 時に削除されていること
		assert.equal(existsSync(agentFile), false, "agent definition must be cleaned up after close");
	} finally {
		await manager.dispose();
		await fake.cleanup();
	}
});

test("manager passes private OpenCode config paths while preserving data-home auth", async () => {
	const fake = await fakeEchoIsolationEnv();
	const originalDataHome = process.env.XDG_DATA_HOME;
	process.env.XDG_DATA_HOME = path.join(os.tmpdir(), "pi-opencode-auth-data");
	const manager = new OpenCodeTaskManager({ binary: fake.binary, binaryArgs: fake.binaryArgs, timeoutMs: 2_000 });
	try {
		const started = manager.spawn(spec("config-isolation", "read_only", ["src"]), process.cwd());
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		const env = JSON.parse(settled.output.trim()) as Record<string, string | undefined>;
		assert.ok(env.configDir?.startsWith(os.tmpdir()));
		assert.ok(env.xdgConfigHome?.startsWith(os.tmpdir()));
		assert.notEqual(env.configDir, env.xdgConfigHome);
		assert.equal(env.dataHome, process.env.XDG_DATA_HOME);
		assert.equal(env.disableProject, "1");
		assert.equal(existsSync(env.xdgConfigHome ?? ""), false, "private worker runtime must be cleaned after close");
	} finally {
		await manager.dispose();
		if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = originalDataHome;
		await fake.cleanup();
	}
});

test("Pi tester tool list includes bash and excludes edit/write", async () => {
	const fake = await fakeEchoArgs();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		piBinary: fake.binary,
		piBinaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	try {
		manager.setModelSetting("worker", "pi::anthropic/example");
		manager.setModelSetting("tester", "pi::test/provider-model");
		const started = manager.spawn(
			{ ...spec("tester-tools", "read_only", ["src"]), role: "tester" },
			repo.dir,
		);
		assert.equal(started.role, "tester");
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		const args = JSON.parse(settled.output.trim());
		const toolsIdx = args.indexOf("--tools");
		assert.ok(toolsIdx >= 0, "--tools not found in Pi args");
		assert.equal(args[toolsIdx + 1], "read,grep,find,ls,bash");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await repo.cleanup();
	}
});

test("Pi reviewer tool list excludes bash, edit, and write", async () => {
	const fake = await fakeEchoArgs();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		piBinary: fake.binary,
		piBinaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	try {
		manager.setModelSetting("worker", "pi::anthropic/example");
		manager.setModelSetting("reviewer", "pi::test/provider-model");
		const started = manager.spawn(
			{ ...spec("reviewer-tools", "read_only", ["src"]), role: "reviewer" },
			repo.dir,
		);
		assert.equal(started.role, "reviewer");
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		const args = JSON.parse(settled.output.trim());
		const toolsIdx = args.indexOf("--tools");
		assert.ok(toolsIdx >= 0, "--tools not found in Pi args");
		assert.equal(args[toolsIdx + 1], "read,grep,find,ls");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await repo.cleanup();
	}
});

test("Pi reviewer thinking resolves high even when the spec asks low", async () => {
	const fake = await fakeEchoArgs();
	const manager = new OpenCodeTaskManager({
		piBinary: fake.binary,
		piBinaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	try {
		manager.setModelSetting("worker", "pi::anthropic/example");
		manager.setModelSetting("reviewer", "pi::test/provider-model");
		const started = manager.spawn(
			{ ...spec("reviewer-thinking", "read_only", ["src"]), role: "reviewer", thinking: "low" },
			process.cwd(),
		);
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		const args = JSON.parse(settled.output.trim());
		const thinkingIdx = args.indexOf("--thinking");
		assert.ok(thinkingIdx >= 0, "--thinking not found in Pi args");
		assert.equal(args[thinkingIdx + 1], "high");
	} finally {
		await manager.dispose();
		await fake.cleanup();
	}
});

test("manager does not pass --agent to Pi workers", async () => {
	const fake = await fakeEchoArgs();
	const manager = new OpenCodeTaskManager({
		piBinary: fake.binary,
		piBinaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	try {
		manager.setModelSetting("worker", "pi::anthropic/example");
		const started = manager.spawn(spec("pi-agent-probe", "read_only", ["src"]), process.cwd());
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		const args = JSON.parse(settled.output.trim());
		assert.equal(args.indexOf("--agent"), -1, "--agent must not be passed to Pi workers");
	} finally {
		await manager.dispose();
		await fake.cleanup();
	}
});

test("role-based tester/reviewer model routing honors explicit model and profile precedence", async () => {
	const fake = await fakeOpenCode();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		testerModel: "opencode-go/tester-role",
		timeoutMs: 2_000,
	});
	try {
		manager.setModelSetting("implementer", "opencode-go/imp-role");
		manager.setModelSetting("reviewer", "opencode-go/rev-role");
		assert.equal(manager.configuration().testerProfile, "opencode-go/tester-role");

		// Batch 1: first 4 spawns, then wait
		const tester = manager.spawn(
			{ ...spec("routing-tester", "read_only", ["src"]), role: "tester" },
			repo.dir,
		);
		assert.equal(tester.role, "tester");
		assert.equal(tester.model, "opencode-go/tester-role");

		const reviewer = manager.spawn(
			{ ...spec("routing-reviewer", "read_only", ["src"]), role: "reviewer" },
			repo.dir,
		);
		assert.equal(reviewer.model, "opencode-go/rev-role");

		const implementer = manager.spawn(
			{ ...spec("routing-impl", "read_only", ["src"]), role: "implementer" },
			repo.dir,
		);
		assert.equal(implementer.model, "opencode-go/imp-role");

		const explicitModel = manager.spawn(
			{ ...spec("routing-explicit", "read_only", ["src"]), role: "tester", model: "opencode-go/explicit" },
			repo.dir,
		);
		assert.equal(explicitModel.model, "opencode-go/explicit");

		await manager.wait([tester.id, reviewer.id, implementer.id, explicitModel.id]);

		// Batch 2: remaining spawns
		const profileWins = manager.spawn(
			{ ...spec("routing-profile", "read_only", ["src"]), role: "reviewer", profile: "implementer" },
			repo.dir,
		);
		assert.equal(profileWins.model, "opencode-go/imp-role");

		const noRole = manager.spawn(spec("routing-bare", "read_only", ["src"]), repo.dir);
		assert.equal(noRole.model, manager.configuration().model);

		await manager.wait([profileWins.id, noRole.id]);

		assert.throws(
			() => manager.spawn({ ...spec("tester-write", "write", ["src"]), role: "tester" }, repo.dir),
			/requires mode read_only/,
		);
		assert.throws(
			() => manager.spawn({ ...spec("reviewer-write", "write", ["src"]), role: "reviewer" }, repo.dir),
			/requires mode read_only/,
		);
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await repo.cleanup();
	}
});

test("manager injects the Executor MCP gateway only for an opted-in OpenCode implementer", async () => {
	const fake = await fakeEchoEnv();
	const repo = await fakeGitRepo();
	const originalEnabled = process.env.PI_ORCH_ENABLE_EXECUTOR;
	const originalBin = process.env.PI_EXECUTOR_BIN;
	process.env.PI_ORCH_ENABLE_EXECUTOR = "1";
	process.env.PI_EXECUTOR_BIN = "executor-test";
	try {
		const manager = new OpenCodeTaskManager({ binary: fake.binary, binaryArgs: fake.binaryArgs, timeoutMs: 2_000 });
		try {
			const started = manager.spawn({ ...spec("executor", "write", ["src"]), role: "implementer", executor: true }, repo.dir);
			const [settled] = await manager.wait([started.id]);
			const config = JSON.parse(settled.output.trim());
			assert.deepEqual(config.mcp.executor, { type: "local", command: ["executor-test", "mcp", "--elicitation-mode", "browser", "--no-artifacts", "--search-tools"] });
		} finally { await manager.dispose(); }
	} finally {
		if (originalEnabled === undefined) delete process.env.PI_ORCH_ENABLE_EXECUTOR; else process.env.PI_ORCH_ENABLE_EXECUTOR = originalEnabled;
		if (originalBin === undefined) delete process.env.PI_EXECUTOR_BIN; else process.env.PI_EXECUTOR_BIN = originalBin;
		await fake.cleanup();
		await repo.cleanup();
	}
});

test("manager rejects Executor routes before task or worktree creation", async () => {
	const manager = new OpenCodeTaskManager({ binary: "must-not-launch" });
	const original = process.env.PI_ORCH_ENABLE_EXECUTOR;
	delete process.env.PI_ORCH_ENABLE_EXECUTOR;
	try {
		assert.throws(() => manager.spawn({ ...spec("executor-disabled", "write", ["src"]), executor: true, role: "implementer" }, process.cwd()), /Executor MCP is disabled/);
		assert.equal(manager.list().length, 0);
		process.env.PI_ORCH_ENABLE_EXECUTOR = "1";
		assert.throws(() => manager.spawn({ ...spec("executor-no-role", "write", ["src"]), executor: true }, process.cwd()), /explicit implementer/);
		assert.throws(() => manager.spawn({ ...spec("executor-pi", "write", ["src"]), executor: true, role: "implementer", model: "pi::provider/model" }, process.cwd()), /OpenCode backend/);
		assert.equal(manager.list().length, 0);
	} finally {
		if (original === undefined) delete process.env.PI_ORCH_ENABLE_EXECUTOR; else process.env.PI_ORCH_ENABLE_EXECUTOR = original;
		await manager.dispose();
	}
});

test("manager discards ambient config before launching role workers", async () => {
	const fake = await fakeEchoEnv();
	const repo = await fakeGitRepo();
	const original = process.env.OPENCODE_CONFIG_CONTENT;
	process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
		theme: "dark",
		mcp: { ambient: { type: "remote" } },
	});
	try {
		const manager = new OpenCodeTaskManager({ binary: fake.binary, binaryArgs: fake.binaryArgs, timeoutMs: 2_000 });
		try {
			const tester = manager.spawn({ ...spec("env-tester", "read_only", ["src"]), role: "tester" }, repo.dir);
			const [testerSettled] = await manager.wait([tester.id]);
			assert.equal(testerSettled.status, "done");
			assert.deepEqual(JSON.parse(testerSettled.output.trim()), { permission: { edit: "deny", bash: { "*": "allow" } } });

			const reviewer = manager.spawn({ ...spec("env-reviewer", "read_only", ["src"]), role: "reviewer" }, repo.dir);
			const [reviewerSettled] = await manager.wait([reviewer.id]);
			assert.equal(reviewerSettled.status, "done");
			assert.deepEqual(JSON.parse(reviewerSettled.output.trim()), { permission: { edit: "deny", bash: "deny" } });
		} finally { await manager.dispose(); }
	} finally {
		if (original === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
		else process.env.OPENCODE_CONFIG_CONTENT = original;
		await fake.cleanup();
		await repo.cleanup();
	}
});

test("tester role succeeds on a clean Git baseline", async () => {
	const fake = await fakeOpenCode();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	try {
		const started = manager.spawn(
			{ ...spec("tester-clean", "read_only", ["src"]), role: "tester" },
			repo.dir,
		);
		assert.equal(started.role, "tester");
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		assert.equal(settled.error, undefined);
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await repo.cleanup();
	}
});

test("manager records agent profile and capability notice in activity", async () => {
	const fake = await fakeEchoArgs();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
		modelCapabilities: { "opencode-go/test-flash": { maxTools: 2, toolSchema: "restricted" } },
	});
	try {
		manager.setModelSetting("worker", "opencode-go/test-flash");
		const started = manager.spawn(spec("cap-probe", "write", ["src"]), process.cwd());
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		const profileActivity = settled.activity.find((a) => a.startsWith("agent profile: coding"));
		assert.ok(profileActivity, "activity must record the agent profile and tool set");
		const capActivity = settled.activity.find((a) => a.startsWith("capability:"));
		assert.ok(capActivity, "activity must record the capability reduction notice");
	} finally {
		await manager.dispose();
		await fake.cleanup();
	}
});

test("tester role succeeds when the baseline is already dirty but unchanged", async () => {
	const fake = await fakeOpenCode();
	const repo = await fakeGitRepo();
	// Pre-dirty the repo before spawning so the captured baseline includes it.
	await writeFile(path.join(repo.dir, "base.txt"), "pre-modified\n", "utf8");
	await writeFile(path.join(repo.dir, "pre-untracked.txt"), "existing\n", "utf8");
	await repo.git(["add", "base.txt"]);
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	try {
		const started = manager.spawn(
			{ ...spec("tester-predirty", "read_only", ["src"]), role: "tester" },
			repo.dir,
		);
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		assert.equal(settled.error, undefined);
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await repo.cleanup();
	}
});

test("tester role flags a worker that mutates a tracked file", async () => {
	const fake = await fakeMutatingOpenCode('writeFileSync("base.txt", "changed\\n", "utf8");');
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	try {
		const started = manager.spawn(
			{ ...spec("tester-tracked", "read_only", ["src"]), role: "tester" },
			repo.dir,
		);
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "error");
		assert.equal(settled.exitCode, 0);
		assert.match(settled.error ?? "", /Tester worker mutated the repository/);
		assert.match(settled.error ?? "", /tracked worktree\/staged content changed/);
		assert.match(settled.error ?? "", /files were NOT reverted/);
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await repo.cleanup();
	}
});

test("tester role flags a worker that stages a change", async () => {
	const fake = await fakeMutatingOpenCode(
		'writeFileSync("added.txt", "new\\n", "utf8"); execFileSync("git", ["add", "added.txt"]);',
	);
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	try {
		const started = manager.spawn(
			{ ...spec("tester-staged", "read_only", ["src"]), role: "tester" },
			repo.dir,
		);
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "error");
		assert.equal(settled.exitCode, 0);
		assert.match(settled.error ?? "", /Tester worker mutated the repository/);
		assert.match(settled.error ?? "", /tracked worktree\/staged content changed/);
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await repo.cleanup();
	}
});

test("tester role flags a worker that creates a nonignored untracked file", async () => {
	const fake = await fakeMutatingOpenCode();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({
		binary: fake.binary,
		binaryArgs: fake.binaryArgs,
		timeoutMs: 2_000,
	});
	try {
		const started = manager.spawn(
			{ ...spec("tester-untracked", "read_only", ["src"]), role: "tester" },
			repo.dir,
		);
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "error");
		assert.equal(settled.exitCode, 0);
		assert.match(settled.error ?? "", /added\/untracked path\(s\)/);
		assert.match(settled.error ?? "", /files were NOT reverted/);
		assert.equal(await readFile(path.join(repo.dir, "mutated.txt"), "utf8"), "changed\n");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await repo.cleanup();
	}
});

test("direct write worker allows an in-scope tracked change", async () => {
	const fake = await fakeMutatingOpenCode('writeFileSync("src/a.txt", "changed\\n", "utf8");');
	const repo = await fakeGitRepo();
	await mkdir(path.join(repo.dir, "src"), { recursive: true });
	const manager = new OpenCodeTaskManager({ binary: fake.binary, binaryArgs: fake.binaryArgs, timeoutMs: 2_000 });
	try {
		const started = manager.spawn(spec("direct-in-scope", "write", ["src/a.txt"]), repo.dir);
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		assert.equal(await readFile(path.join(repo.dir, "src/a.txt"), "utf8"), "changed\n");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await repo.cleanup();
	}
});

test("direct write worker allows an in-scope git mv rename", async () => {
	// `git mv` stages a rename, so the post-run fingerprint must pair the
	// porcelain v1 -z rename record (`R  new\0old`) instead of parsing the bare
	// old-path record as a corrupted status record; both paths are in scope.
	const fake = await fakeMutatingOpenCode('execFileSync("git", ["mv", "src/a.txt", "src/renamed.txt"]);');
	const repo = await fakeGitRepo();
	await mkdir(path.join(repo.dir, "src"), { recursive: true });
	await writeFile(path.join(repo.dir, "src", "a.txt"), "rename me\n", "utf8");
	repo.git(["add", "src/a.txt"]);
	repo.git(["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "rename me"]);
	const manager = new OpenCodeTaskManager({ binary: fake.binary, binaryArgs: fake.binaryArgs, timeoutMs: 2_000 });
	try {
		const started = manager.spawn(spec("direct-git-mv", "write", ["src"]), repo.dir);
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "done");
		assert.ok(!existsSync(path.join(repo.dir, "src", "a.txt")), "the rename source must be gone");
		assert.equal(await readFile(path.join(repo.dir, "src", "renamed.txt"), "utf8"), "rename me\n");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await repo.cleanup();
	}
});

test("direct write worker rejects an out-of-scope tracked change without reverting it", async () => {
	const fake = await fakeMutatingOpenCode('writeFileSync("base.txt", "worker\\n", "utf8");');
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({ binary: fake.binary, binaryArgs: fake.binaryArgs, timeoutMs: 2_000 });
	try {
		const started = manager.spawn(spec("direct-out-tracked", "write", ["src/a.txt"]), repo.dir);
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "error");
		assert.match(settled.error ?? "", /out-of-scope path\(s\).*base\.txt/);
		assert.match(settled.error ?? "", /files were NOT reverted/);
		assert.equal(await readFile(path.join(repo.dir, "base.txt"), "utf8"), "worker\n");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await repo.cleanup();
	}
});

test("direct write worker rejects an out-of-scope untracked change without reverting it", async () => {
	const fake = await fakeMutatingOpenCode();
	const repo = await fakeGitRepo();
	const manager = new OpenCodeTaskManager({ binary: fake.binary, binaryArgs: fake.binaryArgs, timeoutMs: 2_000 });
	try {
		const started = manager.spawn(spec("direct-out-untracked", "write", ["src/a.txt"]), repo.dir);
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "error");
		assert.match(settled.error ?? "", /out-of-scope path\(s\).*mutated\.txt/);
		assert.match(settled.error ?? "", /not a sandbox/);
		assert.equal(await readFile(path.join(repo.dir, "mutated.txt"), "utf8"), "changed\n");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await repo.cleanup();
	}
});

test("direct write scope guard compares against a dirty baseline", async () => {
	const fake = await fakeMutatingOpenCode('writeFileSync("base.txt", "worker\\n", "utf8");');
	const repo = await fakeGitRepo();
	await writeFile(path.join(repo.dir, "base.txt"), "pre-existing\\n", "utf8");
	const manager = new OpenCodeTaskManager({ binary: fake.binary, binaryArgs: fake.binaryArgs, timeoutMs: 2_000 });
	try {
		const started = manager.spawn(spec("direct-dirty-change", "write", ["src/a.txt"]), repo.dir);
		const [settled] = await manager.wait([started.id]);
		assert.equal(settled.status, "error");
		assert.match(settled.error ?? "", /out-of-scope path\(s\).*base\.txt/);
		assert.equal(await readFile(path.join(repo.dir, "base.txt"), "utf8"), "worker\n");
	} finally {
		await manager.dispose();
		await fake.cleanup();
		await repo.cleanup();
	}
});

test("direct write scope guard respects path boundaries and Japanese paths", async () => {
	const boundaryFake = await fakeMutatingOpenCode('writeFileSync("src/a-b.txt", "changed\\n", "utf8");');
	const repo = await fakeGitRepo();
	await mkdir(path.join(repo.dir, "src"), { recursive: true });
	const manager = new OpenCodeTaskManager({ binary: boundaryFake.binary, binaryArgs: boundaryFake.binaryArgs, timeoutMs: 2_000 });
	try {
		const boundary = manager.spawn(spec("direct-prefix-boundary", "write", ["src/a"]), repo.dir);
		const [boundarySettled] = await manager.wait([boundary.id]);
		assert.equal(boundarySettled.status, "error");
		assert.match(boundarySettled.error ?? "", /out-of-scope path\(s\).*src\/a-b\.txt/);
	} finally {
		await manager.dispose();
		await boundaryFake.cleanup();
		await repo.cleanup();
	}

	const japaneseFake = await fakeMutatingOpenCode('writeFileSync("日本語/対象.txt", "変更\\n", "utf8");');
	const japaneseRepo = await fakeGitRepo();
	await mkdir(path.join(japaneseRepo.dir, "日本語"), { recursive: true });
	const japaneseManager = new OpenCodeTaskManager({ binary: japaneseFake.binary, binaryArgs: japaneseFake.binaryArgs, timeoutMs: 2_000 });
	try {
		const japanese = japaneseManager.spawn(spec("direct-japanese", "write", ["日本語/対象.txt"]), japaneseRepo.dir);
		const [settled] = await japaneseManager.wait([japanese.id]);
		assert.equal(settled.status, "done");
		assert.equal(await readFile(path.join(japaneseRepo.dir, "日本語", "対象.txt"), "utf8"), "変更\n");
	} finally {
		await japaneseManager.dispose();
		await japaneseFake.cleanup();
		await japaneseRepo.cleanup();
	}
});

test("tester role spawn rejects outside a Git worktree", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pi-opencode-nongit-"));
	try {
		const manager = new OpenCodeTaskManager({
			binary: process.execPath,
			binaryArgs: [],
			timeoutMs: 2_000,
		});
		try {
			assert.throws(
				() => manager.spawn({ ...spec("tester-nongit", "read_only", ["src"]), role: "tester" }, dir),
				/Tester role requires a Git worktree with a capturable baseline/,
			);
		} finally {
			await manager.dispose();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
