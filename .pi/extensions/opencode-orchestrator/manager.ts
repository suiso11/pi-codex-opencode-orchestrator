import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, type Hash } from "node:crypto";
import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	readlinkSync,
	type Stats,
	unlinkSync,
	writeSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	InternalTaskSpec,
	ModelProfile,
	TaskMode,
	RetainedWorktreeView,
	TaskSnapshot,
	TaskSpec,
	ThinkingLevel,
	WorkerBackend,
	WorkerRole,
	WorktreeRetentionKind,
	WorktreeSnapshotInfo,
} from "./types.ts";
import {
	boundedAppend,
	buildWorkerPrompt,
	configuredModelCapabilities,
	configuredModelProfiles,
	configuredTesterProfile,
	configuredThinkingLevel,
	decodeWorkerModel,
	DEFAULT_MODEL,
	DEFAULT_TOOL_PROFILE,
	extractUsageFromEvent,
	findScopeConflict,
	MAX_ACTIVITY_ITEMS,
	MAX_RUNNING,
	MAX_TRACKED,
	mergeUsage,
	MODEL_PROFILE_DEFAULTS,
	normalizeScopes,
	normalizeWorkerModelValue,
	parseWorkerReport,
	pathForScopeComparison,
	resolveModel,
	resolveThinkingLevel,
	type ModelCapability,
	type ToolProfile,
} from "./types.ts";
import type { BackendPreparation, WorkerBackendAdapter } from "./backends/backend.ts";
import { executorGateError, OpenCodeBackendAdapter } from "./backends/opencode.ts";
import { PiBackendAdapter } from "./backends/pi.ts";
import { CollieBackendAdapter, collieGateError, collieModelParts } from "./backends/collie.ts";
import { buildWorkerEnv } from "./worker-env.ts";

interface ManagedTask {
	snapshot: TaskSnapshot;
	child?: ChildProcess;
	agentName?: string;
	preparation?: BackendPreparation;
	backendCleanupDone?: boolean;
	buffer: string;
	stderrBuffer: string;
	settleListeners: Set<() => void>;
	waiters: number;
	consumed: boolean;
	delivered: boolean;
	cancelRequested: boolean;
	cwd?: string;
	childCwd?: string;
	baselineFingerprint?: GitFingerprint;
	// Direct write workers use the same post-run Git guard as tester workers,
	// but additionally enforce the worker's declared scopes.
	gitGuard?: "tester" | "direct-write";
	worktree?: WorktreeRuntime;
}

interface GitFingerprint {
	// HEAD is part of the fingerprint, not merely an informational field. This
	// makes a checkout/reset/branch switch observable even when the resulting
	// tree is clean. The symbolic ref catches a branch switch that happens to
	// point at the same commit; detached shadows normalize it to the root ref
	// before comparison.
	headOid: string;
	headRef?: string;
	hash: string;
	paths: string[];
	// Per-path content/state hashes let us distinguish a worker mutation from a
	// pre-existing dirty path with the same name.
	pathHashes: Map<string, string>;
}

interface GitFingerprintComparison {
	mutated: boolean;
	changedPaths: string[];
	currentPaths: string[];
	error?: string;
}

// Per-task worktree runtime. The absolute worktree path lives only here and in
// the retained-worktree registry; it is never placed on TaskSnapshot.
interface WorktreeRuntime {
	path: string;
	repoRoot: string;
	childCwd: string;
	baseHead: string;
	scopes: string[];
	batch: WorktreeBatch;
	patchPath?: string;
	patchBuffer?: Buffer;
	changedPaths?: string[];
	// Repo-relative paths that fell outside the declared scopes during
	// finalization, held for the public retained-worktree detail view.
	conflictPaths?: string[];
}

// A per-repository batch of worktree tasks sharing one clean base HEAD. Tasks
// must be spawned before the batch settles; integration is strictly ID-ordered.
interface WorktreeBatch {
	repoRoot: string;
	key: string;
	// The immutable batch start HEAD is also the base for every shadow
	// postcondition calculation.
	baseHead: string;
	expectedFingerprint: GitFingerprint;
	// Only buffers whose root apply has passed its exact postcondition are kept.
	// They let a later shadow replay the root's complete expected state without
	// trusting the live worktree or a mutable archive.
	integratedPatchBuffers: Buffer[];
	tasks: ManagedTask[];
	poisoned: boolean;
	open: boolean;
}

// Retained (never auto-deleted) worktree state kept for a later cleanup UI.
// The absolute path is stored here only; model-facing serialization stays clean.
// The absolute path/patchPath come solely from the private WorktreeRuntime that
// this manager created; callers can never supply a path to cleanup/retry.
interface RetainedWorktree {
	taskId: string;
	name: string;
	path: string;
	repoRoot: string;
	baseHead: string;
	baseHeadRef?: string;
	scopes: string[];
	changedPaths: string[];
	conflictPaths: string[];
	status: TaskSnapshot["status"];
	error?: string;
	createdAt: number;
	patchPath?: string;
	patchBuffer?: Buffer;
	kind: WorktreeRetentionKind;
	retryable: boolean;
	rootIntegrated: boolean;
}

interface ManagerOptions {
	allowWorktrees?: boolean;
	onChange?: () => void;
	binary?: string;
	binaryArgs?: string[];
	model?: string;
	timeoutMs?: number;
	piBinary?: string;
	piBinaryArgs?: string[];
	collieBinary?: string;
	collieBinaryArgs?: string[];
	thinkingLevel?: ThinkingLevel;
	modelCapabilities?: Record<string, ModelCapability>;
	defaultToolProfile?: ToolProfile;
	testerModel?: string;
}

function defaultPiCommand() {
	try {
		const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		return {
			binary: process.execPath,
			args: [path.join(path.dirname(packageEntry), "cli.js")],
		};
	} catch {
		return {
			binary: "pi",
			args: [],
		};
	}
}

function configuredTimeout(value?: number) {
	const parsed = value ?? Number(process.env.PI_OPENCODE_TIMEOUT_MS ?? 10 * 60 * 1000);
	if (!Number.isFinite(parsed)) return 10 * 60 * 1000;
	return Math.min(Math.max(parsed, 10_000), 30 * 60 * 1000);
}

// Canonicalize a manager-owned worker model value before storage. The display-
// only `opencode:` prefix and any repeated legacy spelling are collapsed by
// normalizeWorkerModelValue; `pi::provider/model` values are preserved verbatim.
// Values that normalize away entirely fall back to the supplied default so the
// manager never stores an empty or non-canonical model in manager-owned state.
function canonicalManagerModel(value: string, fallback: string): string {
	return normalizeWorkerModelValue(value) || fallback;
}

// Small grace window added to the configured worker timeout for the bounded
// integration-order wait, so a finalized higher-ID task cannot poll forever
// behind an unkillable/lower-ID task.
const INTEGRATION_ORDER_GRACE_MS = 30_000;

function processError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

// Explicit internal retention code passed at every markWorktreeRetained call
// site, replacing error-substring classification. These codes map onto the
// public WorktreeRetentionKind values via retentionKindOf, preserving current
// public views and retryable derivation: "timeout" is surfaced as
// worker-failure and "integration-conflict" as integration-failure (the only
// retryable public kind).
type RetentionCode =
	| "worker-failure"
	| "cancel"
	| "timeout"
	| "out-of-scope"
	| "commit"
	| "gitlink"
	| "integration-conflict"
	| "post-integration-fingerprint"
	| "cleanup-failed";

// Internal error carrying the retention code that applies when a worktree task
// fails during finalization/integration and is therefore retained.
class RetentionError extends Error {
	readonly code: RetentionCode;

	constructor(code: RetentionCode, message: string) {
		super(message);
		this.name = "RetentionError";
		this.code = code;
	}
}

function retentionCodeOf(error: unknown): RetentionCode {
	return error instanceof RetentionError ? error.code : "worker-failure";
}

// Map an internal retention code onto the public WorktreeRetentionKind value,
// preserving the current public views and the retryable derivation.
function retentionKindOf(code: RetentionCode): WorktreeRetentionKind {
	switch (code) {
		case "timeout":
			return "worker-failure";
		case "integration-conflict":
			return "integration-failure";
		case "post-integration-fingerprint":
			return "cleanup-failed";
		default:
			return code;
	}
}

// Synchronous sleep for bounded Windows retry loops. Uses Atomics.wait on a
// shared buffer, which blocks the current thread without a busy spin.
function sleepSync(ms: number) {
	const buffer = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(buffer, 0, 0, ms);
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
	if (!child.pid) return;
	try {
		if (os.platform() !== "win32") process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// The process may already have exited.
		}
	}
}

function runGit(cwd: string, args: string[]): Buffer | undefined {
	try {
		return execFileSync("git", args, { cwd, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return undefined;
	}
}

// argv-based git runner that also returns captured stderr for diagnostics.
// Always execFileSync with shell=false; no command concatenation.
function runGitResult(cwd: string, args: string[], input?: Buffer) {
	try {
		const stdout = execFileSync("git", args, {
			cwd,
			encoding: "buffer",
			stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			...(input === undefined ? {} : { input }),
		});
		return { ok: true as const, stdout, stderr: Buffer.alloc(0) };
	} catch (error) {
		const err = error as { stderr?: Buffer; stdout?: Buffer };
		return {
			ok: false as const,
			stdout: err.stdout ?? Buffer.alloc(0),
			stderr: err.stderr ?? Buffer.from(processError(error)),
		};
	}
}

function splitNul(buffer: Buffer): string[] {
	return buffer.toString("utf8").split("\0").filter((value) => value.length > 0);
}

// One resolved path/status pair from a `git status --porcelain=v1 -z` record.
export interface PorcelainStatusEntry {
	path: string;
	status: string;
}

// Parse NUL-delimited porcelain v1 status records into per-path pairs. A plain
// record is "<XY> path" (untracked entries are "?? path"), but with -z a
// rename/copy record is a positional pair: "<XY> new" followed by a separate
// bare record holding the old path. The source record carries no XY prefix,
// so it must be consumed as the next record and never re-parsed as a status
// record of its own (a naive slice(3) would corrupt the source path and
// register a phantom path). Whenever the index or the worktree status is R/C,
// both the new and old paths are registered with the record's XY status so
// both sides of the rename join the fingerprint.
export function parsePorcelainStatusRecords(records: readonly string[]): PorcelainStatusEntry[] {
	const entries: PorcelainStatusEntry[] = [];
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (record.length === 0) continue;
		// A status record always carries an XY pair, one space, and at least one
		// path character; positionally consumed rename sources never reach this
		// branch, so only a malformed short record degrades to a bare path.
		if (record.length <= 3 || record[2] !== " ") {
			entries.push({ path: record, status: "" });
			continue;
		}
		const status = record.slice(0, 2);
		entries.push({ path: record.slice(3), status });
		if (status[0] === "R" || status[1] === "R" || status[0] === "C" || status[1] === "C") {
			const source = records[index + 1];
			if (source !== undefined && source.length > 0) {
				entries.push({ path: source, status });
				index++;
			}
		}
	}
	return entries;
}

// A fingerprint is clean when no tracked/staged diff and no nonignored
// untracked paths exist (paths are captured from porcelain status + untracked).
function isCleanFingerprint(fp: GitFingerprint) {
	return fp.paths.length === 0;
}

function sameGitFingerprint(left: GitFingerprint, right: GitFingerprint): boolean {
	if (left.headOid !== right.headOid || left.headRef !== right.headRef || left.hash !== right.hash) return false;
	if (left.paths.length !== right.paths.length || left.paths.some((item, index) => item !== right.paths[index])) return false;
	if (left.pathHashes.size !== right.pathHashes.size) return false;
	for (const [relative, hash] of left.pathHashes) {
		if (right.pathHashes.get(relative) !== hash) return false;
	}
	return true;
}

function pathWithinScope(fileAbs: string, scope: string) {
	// Containment is decided with path.relative (not a string prefix) so that
	// Japanese/space-containing paths and prefix lookalikes (e.g. scope "src/a"
	// vs file "src/a-b/c") are handled correctly on every platform.
	const relative = path.relative(pathForScopeComparison(scope), pathForScopeComparison(fileAbs));
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Stable OS-temp base directory derived from the repository root hash. Working
// directories are never placed inside the repository itself.
function worktreeRootDir(repoRoot: string) {
	const digest = createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
	return path.join(os.tmpdir(), "oc-worktrees", digest);
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// JSON string escaping matching JSON.stringify's content rules: backslash,
// double-quote, and control characters are escaped exactly as they appear
// inside a JSON string literal (without the surrounding quotes). This lets the
// redactor match worktree paths that worker text embeds inside JSON structures,
// e.g. a report line whose absolute Windows path appears with doubled
// backslashes such as C:\\...\\oc-worktrees\\<digest>.
function jsonStringEscape(value: string): string {
	return JSON.stringify(value).slice(1, -1);
}

// All absolute temp-path spellings that may legitimately appear in Git
// diagnostics or worker text for a worktree task. Variants with both separator
// styles are included so msys-style forward-slash output is also caught. Each
// spelling is additionally matched in its JSON-string-escaped form by
// redactAbsolutePaths, so worktree/state/patch/cwd paths embedded in
// JSON-escaped worker text (Windows doubled backslashes) are redacted too.
function worktreeRedactionPaths(wt: WorktreeRuntime): string[] {
	const candidates = new Set<string>();
	const add = (value: string | undefined) => {
		if (!value) return;
		candidates.add(value);
		candidates.add(value.replaceAll(path.sep, path.posix.sep));
		if (path.sep !== path.posix.sep) candidates.add(value.replaceAll(path.posix.sep, path.sep));
	};
	add(wt.path);
	add(wt.childCwd);
	add(wt.patchPath);
	add(worktreeRootDir(wt.repoRoot));
	return [...candidates].filter((value) => value.length >= 4);
}

// Redact absolute temp worktree/state paths from a text blob before it reaches
// any snapshot.error / stderr / model-facing surface. Longest paths are
// replaced first so subpaths are never left partially revealed. Each candidate
// is also matched in its JSON-string-escaped form (Windows backslashes doubled
// to "\\"), so JSON-escaped absolute worktree paths inside worker output cannot
// slip through; both spellings are replaced with the <worktree> marker without
// corrupting any other text.
function redactAbsolutePaths(text: string, paths: (string | undefined)[]): string {
	if (!text || paths.length === 0) return text;
	const expanded = new Set<string>();
	for (const value of paths) {
		if (!value) continue;
		expanded.add(value);
		expanded.add(jsonStringEscape(value));
	}
	const sorted = [...expanded].sort((a, b) => b.length - a.length);
	const flags = process.platform === "win32" ? "gi" : "g";
	const pattern = new RegExp(sorted.map((value) => escapeRegExp(value)).join("|"), flags);
	return text.replace(pattern, "<worktree>");
}

// Fingerprinted regular files are read from a descriptor in bounded chunks and
// never buffered whole in memory; a file whose initial size exceeds this cap
// fails the whole fingerprint closed instead of degrading to a partial hash.
export const FINGERPRINT_MAX_FILE_BYTES = 64 * 1024 * 1024;

// Upper bound on one fingerprint read chunk.
const FINGERPRINT_READ_CHUNK_BYTES = 1024 * 1024;

// O_NOFOLLOW is not available on every platform (Windows libuv lacks it), so it
// is OR-ed in only where present. Where it is missing, the post-open fstat
// identity check still catches a swapped-in symlink: the opened descriptor
// would describe the link target's device/inode instead of the lstat'ed path.
const O_NOFOLLOW_IF_AVAILABLE = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

// Outcome of hashing one working-tree path without following symlinks.
// ok:false marks an unstable, swapped, oversized, or unsupported path; the
// caller must fail the whole fingerprint instead of continuing.
export type PathHashOutcome =
	| { ok: true; kind: "file" | "symlink" | "special" | "missing" }
	| { ok: false; reason: string };

// Stable identity of a path: the device/inode pair the kernel reports.
function samePathIdentity(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

// Stable kind key so a mid-hash type change (e.g. a file replaced by a FIFO)
// is detectable as an identity change.
function pathKindKey(stats: Stats): string {
	if (stats.isFile()) return "file";
	if (stats.isSymbolicLink()) return "symlink";
	if (stats.isDirectory()) return "directory";
	if (stats.isFIFO()) return "fifo";
	if (stats.isSocket()) return "socket";
	if (stats.isBlockDevice()) return "block";
	if (stats.isCharacterDevice()) return "char";
	return "other";
}

/**
 * Hash one working-tree path for the Git fingerprint without ever following a
 * symlink and without opening anything other than a verified regular file.
 *
 * - lstat decides the kind. A symlink contributes only its own mode and target
 *   bytes (readlinkSync, never open/read of the target), so an external or
 *   oversized target can never influence or block the hash.
 * - A regular file is opened O_RDONLY (plus O_NOFOLLOW where available); the
 *   opened descriptor's fstat must match the pre-open lstat identity
 *   (dev/ino/type), the initial size must stay under the hard cap, exactly
 *   that many bytes are hashed via bounded readSync chunks, and a post-read
 *   fstat plus a post-close lstat must show size/dev/ino/type unchanged.
 * - FIFOs, sockets, devices, and directories are never opened (opening a FIFO
 *   could block forever); only their lstat metadata is hashed, with a second
 *   lstat confirming the identity did not change.
 * - A path that is already absent is a stable Git-visible state (deleted dirty
 *   paths and rename sources) and records the same "<missing>" marker as
 *   before. Any ENOENT, error, or identity mismatch detected *during* the
 *   operation (open, read, readlink, re-stat) returns ok:false so the caller
 *   fails the whole fingerprint closed.
 */
export function hashPathWithoutFollowing(hash: Hash, file: string): PathHashOutcome {
	let before: Stats;
	try {
		before = lstatSync(file);
	} catch (error) {
		if (!isMissingFile(error)) return { ok: false, reason: "path could not be inspected" };
		hash.update(Buffer.from("<missing>"));
		return { ok: true, kind: "missing" };
	}
	if (before.isSymbolicLink()) {
		let target: Buffer;
		try {
			target = readlinkSync(file, "buffer");
		} catch {
			return { ok: false, reason: "symlink target could not be read" };
		}
		let after: Stats;
		let targetAfter: Buffer;
		try {
			after = lstatSync(file);
			targetAfter = readlinkSync(file, "buffer");
		} catch {
			return { ok: false, reason: "symlink changed while being hashed" };
		}
		if (
			!after.isSymbolicLink() || !samePathIdentity(before, after) || after.mode !== before.mode ||
			!targetAfter.equals(target)
		) {
			return { ok: false, reason: "symlink identity changed while being hashed" };
		}
		hash.update(Buffer.from(`symlink\0${before.mode}:${target.length}\0`, "utf8"));
		hash.update(target);
		return { ok: true, kind: "symlink" };
	}
	if (
		before.isDirectory() || before.isFIFO() || before.isSocket() || before.isBlockDevice() ||
		before.isCharacterDevice()
	) {
		let after: Stats;
		try {
			after = lstatSync(file);
		} catch {
			return { ok: false, reason: "special path changed while being hashed" };
		}
		if (!samePathIdentity(before, after) || after.mode !== before.mode || after.size !== before.size ||
			pathKindKey(before) !== pathKindKey(after)
		) {
			return { ok: false, reason: "special path identity changed while being hashed" };
		}
		// Only lstat metadata is hashed: a FIFO open could block forever and
		// device/socket state has no safe byte stream to read.
		hash.update(
			Buffer.from(`special\0${before.mode}:${before.size}:${before.dev}:${before.ino}:${before.mtimeMs}\0`, "utf8"),
		);
		return { ok: true, kind: "special" };
	}
	if (!before.isFile()) return { ok: false, reason: "unsupported path kind" };
	let fd: number | undefined;
	try {
		fd = openSync(file, fsConstants.O_RDONLY | O_NOFOLLOW_IF_AVAILABLE);
		const opened = fstatSync(fd);
		if (!opened.isFile() || !samePathIdentity(before, opened) || pathKindKey(opened) !== pathKindKey(before)) {
			return { ok: false, reason: "opened file does not match the inspected path" };
		}
		if (opened.size > FINGERPRINT_MAX_FILE_BYTES) {
			return { ok: false, reason: "file exceeds the fingerprint size cap" };
		}
		hash.update(Buffer.from(`file\0${opened.mode}:${opened.size}\0`, "utf8"));
		const chunk = Buffer.allocUnsafe(Math.min(FINGERPRINT_READ_CHUNK_BYTES, Math.max(opened.size, 1)));
		let read = 0;
		while (read < opened.size) {
			const want = Math.min(chunk.length, opened.size - read);
			const got = readSync(fd, chunk, 0, want, read);
			if (got <= 0) return { ok: false, reason: "file read made no progress" };
			hash.update(got === chunk.length ? chunk : chunk.subarray(0, got));
			read += got;
		}
		const after = fstatSync(fd);
		if (!after.isFile() || !samePathIdentity(before, after) || after.size !== opened.size) {
			return { ok: false, reason: "file changed while being hashed" };
		}
		closeSync(fd);
		fd = undefined;
		let afterPath: Stats;
		try {
			afterPath = lstatSync(file);
		} catch {
			return { ok: false, reason: "path changed while being hashed" };
		}
		if (!afterPath.isFile() || !samePathIdentity(before, afterPath) || afterPath.size !== opened.size) {
			return { ok: false, reason: "path was swapped while being hashed" };
		}
		return { ok: true, kind: "file" };
	} catch {
		return { ok: false, reason: "file could not be hashed" };
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch { /* preserve the original failure */ }
		}
	}
}

function requiredGit(cwd: string, args: string[]): Buffer | undefined {
	const result = runGitResult(cwd, args);
	return result.ok ? result.stdout : undefined;
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function validatePatchStats(stats: { isFile(): boolean; nlink: number }, phase: string) {
	if (!stats.isFile() || stats.nlink !== 1) {
		throw new Error(`Secure patch archive ${phase} validation failed; refusing to use the archive.`);
	}
}

// Keep a diagnostic/retention archive without ever overwriting a path. The
// archive is not trusted for integration: all git apply operations consume the
// manager-owned buffer directly. O_EXCL plus descriptor validation prevents a
// worker-created collision, symlink, or hardlink from becoming the archive.
function createPatchArchive(baseDir: string, patch: Buffer): string {
	const patchPath = path.join(baseDir, `patch-${randomBytes(24).toString("hex")}.patch`);
	let fd: number | undefined;
	try {
		fd = openSync(patchPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
		validatePatchStats(fstatSync(fd), "creation");
		let offset = 0;
		while (offset < patch.length) {
			const written = writeSync(fd, patch, offset, patch.length - offset);
			if (written <= 0) throw new Error("Secure patch archive write made no progress; refusing to continue.");
			offset += written;
		}
		validatePatchStats(fstatSync(fd), "post-write");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		// Validate the name after closing too. This archive is only retained for
		// cleanup/UI, but a substituted path must still fail closed.
		validatePatchStats(lstatSync(patchPath), "path");
		return patchPath;
	} catch (error) {
		if (fd !== undefined) {
			try { closeSync(fd); } catch { /* preserve the original failure */ }
		}
		throw error;
	}
}

/**
 * Capture a content-based Git fingerprint of the working tree: tracked worktree
 * diff, staged diff, and nonignored untracked paths with their contents. Paths
 * are NUL-safe (git -z), gitignore-aware (--exclude-standard), and every path's
 * bytes are hashed through hashPathWithoutFollowing, so no symlink is ever
 * followed, no special file is ever opened, and no whole file is ever buffered
 * in memory. File contents are hashed internally and never exposed; only path
 * names are kept for the change diagnostic. Any unstable or oversized path
 * fails the whole capture closed (undefined).
 */
export function captureGitFingerprint(cwd: string): GitFingerprint | undefined {
	const worktreeCheck = requiredGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (!worktreeCheck || worktreeCheck.toString("utf8").trim() !== "true") return undefined;
	const head = requiredGit(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
	const headOid = head?.toString("utf8").trim();
	if (!headOid) return undefined;
	const headRefResult = runGitResult(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const headRef = headRefResult.ok ? headRefResult.stdout.toString("utf8").trim() || undefined : undefined;
	const hash = createHash("sha256");
	hash.update(Buffer.from("head-oid\0"));
	hash.update(Buffer.from(headOid, "utf8"));
	hash.update(Buffer.from("\0"));
	const paths = new Set<string>();

	hash.update(Buffer.from("worktree-diff\0"));
	const worktreeDiff = requiredGit(cwd, ["diff", "--no-color", "--binary"]);
	if (!worktreeDiff) return undefined;
	hash.update(worktreeDiff);
	hash.update(Buffer.from("\0staged-diff\0"));
	const stagedDiff = requiredGit(cwd, ["diff", "--cached", "--no-color", "--binary"]);
	if (!stagedDiff) return undefined;
	hash.update(stagedDiff);
	hash.update(Buffer.from("\0untracked\0"));
	const untracked = requiredGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
	if (!untracked) return undefined;
	for (const relative of splitNul(untracked)) {
		paths.add(relative);
		hash.update(Buffer.from(relative, "utf8"));
		hash.update(Buffer.from("\0"));
		if (!hashPathWithoutFollowing(hash, path.join(cwd, relative)).ok) return undefined;
		hash.update(Buffer.from("\0"));
	}
	const status = requiredGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
	if (!status) return undefined;
	const statusByPath = new Map<string, string>();
	for (const { path: relative, status: xy } of parsePorcelainStatusRecords(splitNul(status))) {
		paths.add(relative);
		statusByPath.set(relative, xy);
	}

	// Capture state for every currently dirty/untracked path. Besides the
	// working-tree bytes, include both index and worktree diffs so a dirty
	// baseline remains distinguishable when the worker changes the same path.
	const pathHashes = new Map<string, string>();
	for (const relative of paths) {
		const pathHash = createHash("sha256");
		pathHash.update(statusByPath.get(relative) ?? "");
		pathHash.update(Buffer.from("\\0worktree-content\\0"));
		if (!hashPathWithoutFollowing(pathHash, path.join(cwd, relative)).ok) return undefined;
		pathHash.update(Buffer.from("\\0unstaged-diff\\0"));
		const unstaged = requiredGit(cwd, ["diff", "--no-color", "--binary", "--full-index", "--", relative]);
		if (!unstaged) return undefined;
		pathHash.update(unstaged);
		pathHash.update(Buffer.from("\\0staged-diff\\0"));
		const staged = requiredGit(cwd, ["diff", "--cached", "--no-color", "--binary", "--full-index", "--", relative]);
		if (!staged) return undefined;
		pathHash.update(staged);
		pathHashes.set(relative, pathHash.digest("hex"));
	}
	return { headOid, headRef, hash: hash.digest("hex"), paths: [...paths].sort(), pathHashes };
}

function compareGitFingerprint(baseline: GitFingerprint, cwd: string): GitFingerprintComparison {
	const after = captureGitFingerprint(cwd);
	if (!after) {
		return {
			mutated: true,
			changedPaths: [],
			currentPaths: [],
			error: "the repository fingerprint could not be re-captured after the worker finished",
		};
	}
	const candidates = new Set([...baseline.pathHashes.keys(), ...after.pathHashes.keys()]);
	const changedPaths = [...candidates]
		.filter((relative) => baseline.pathHashes.get(relative) !== after.pathHashes.get(relative))
		.sort();
	return {
		mutated: !sameGitFingerprint(baseline, after) || changedPaths.length > 0,
		changedPaths,
		currentPaths: after.paths,
	};
}

function detectMutationMessage(baseline: GitFingerprint, comparison: GitFingerprintComparison): string | undefined {
	if (comparison.error) return comparison.error;
	if (!comparison.mutated) return undefined;
	const before = new Set(baseline.paths);
	const now = new Set(comparison.currentPaths);
	const added = [...now].filter((item) => !before.has(item)).sort();
	const removed = [...before].filter((item) => !now.has(item)).sort();
	const details: string[] = [];
	if (added.length > 0) details.push(`${added.length} added/untracked path(s)`);
	if (removed.length > 0) details.push(`${removed.length} removed path(s)`);
	details.push("tracked worktree/staged content changed");
	return `${details.join(", ")}; files were NOT reverted`;
}

function detectMutation(baseline: GitFingerprint, cwd: string): string | undefined {
	return detectMutationMessage(baseline, compareGitFingerprint(baseline, cwd));
}

export class OpenCodeTaskManager {
	private readonly tasks = new Map<string, ManagedTask>();
	private counter = 0;
	private readonly allowWorktrees: boolean;
	private disposed = false;
	private capacityListeners = new Set<() => void>();
	private readonly onChange?: () => void;
	private readonly binary: string;
	private readonly binaryArgs: string[];
	private defaultModel: string;
	private modelProfiles: Record<ModelProfile, string>;
	private testerModel: string;
	private readonly timeoutMs: number;
	private readonly piBinary: string;
	private readonly piBinaryArgs: string[];
	private readonly collieBinary: string;
	private readonly collieBinaryArgs: string[];
	private thinkingLevel: ThinkingLevel;
	private readonly modelCapabilities: Record<string, ModelCapability>;
	private readonly defaultToolProfile: ToolProfile;
	private readonly worktreeBatches = new Map<string, WorktreeBatch>();
	private readonly retainedWorktrees = new Map<string, RetainedWorktree>();
	private readonly backends: Record<WorkerBackend, WorkerBackendAdapter>;

	constructor(options: ManagerOptions = {}) {
		this.allowWorktrees = options.allowWorktrees ?? true;
		this.onChange = options.onChange;
		this.binary = options.binary ?? process.env.PI_OPENCODE_BIN ?? "opencode";
		this.binaryArgs = options.binaryArgs ?? [];
		this.defaultModel = canonicalManagerModel(options.model ?? process.env.PI_OPENCODE_MODEL ?? "", DEFAULT_MODEL);
		const profiles = configuredModelProfiles();
		this.modelProfiles = {
			implementer: canonicalManagerModel(profiles.implementer, MODEL_PROFILE_DEFAULTS.implementer),
			reviewer: canonicalManagerModel(profiles.reviewer, MODEL_PROFILE_DEFAULTS.reviewer),
		};
		this.testerModel = canonicalManagerModel(options.testerModel ?? configuredTesterProfile(), DEFAULT_MODEL);
		this.timeoutMs = configuredTimeout(options.timeoutMs);
		this.thinkingLevel = options.thinkingLevel ?? configuredThinkingLevel();
		this.modelCapabilities = options.modelCapabilities ?? configuredModelCapabilities();
		this.defaultToolProfile = options.defaultToolProfile ?? DEFAULT_TOOL_PROFILE;
		const piCommand = defaultPiCommand();
		this.piBinary = options.piBinary ?? piCommand.binary;
		this.piBinaryArgs = options.piBinaryArgs ?? piCommand.args;
		this.collieBinary = options.collieBinary ?? process.env.PI_COLLIE_BIN ?? "collie";
		this.collieBinaryArgs = options.collieBinaryArgs ?? [];
		this.backends = {
			opencode: new OpenCodeBackendAdapter({
				binary: this.binary,
				binaryArgs: this.binaryArgs,
				defaultToolProfile: this.defaultToolProfile,
				modelCapabilities: this.modelCapabilities,
			}),
			pi: new PiBackendAdapter({ binary: this.piBinary, binaryArgs: this.piBinaryArgs }),
			collie: new CollieBackendAdapter({ binary: this.collieBinary, binaryArgs: this.collieBinaryArgs }),
		};
	}

	configuration() {
		return {
			binary: this.binary,
			piBinary: this.piBinary,
			collieBinary: this.collieBinary,
			model: this.defaultModel,
			profiles: { ...this.modelProfiles },
			testerProfile: this.testerModel,
			timeoutMs: this.timeoutMs,
			maxRunning: MAX_RUNNING,
			thinkingLevel: this.thinkingLevel,
		};
	}

	setModelSetting(target: "worker" | ModelProfile | "tester", model: string) {
		const value = normalizeWorkerModelValue(model);
		if (!value) throw new Error("OpenCode model must not be empty.");
		if (target === "worker") this.defaultModel = value;
		else if (target === "tester") this.testerModel = value;
		else this.modelProfiles[target] = value;
		this.notify();
	}

	setThinkingLevel(level: ThinkingLevel) {
		this.thinkingLevel = level;
		this.notify();
	}

	private notify() {
		this.onChange?.();
		for (const listener of this.capacityListeners) listener();
		this.capacityListeners.clear();
	}

	private runningEntries() {
		return [...this.tasks.values()].filter((entry) => entry.snapshot.status === "running");
	}

	runningCount() {
		return this.runningEntries().length;
	}

	private conflictFor(spec: InternalTaskSpec, cwd: string) {
		if (spec.mode !== "write") return undefined;
		const scopes = normalizeScopes(cwd, spec.relevantPaths);
		for (const entry of this.runningEntries()) {
			if (entry.snapshot.mode !== "write") continue;
			const conflict = findScopeConflict(scopes, entry.snapshot.scopes);
			if (conflict) return { task: entry.snapshot, conflict };
		}
		return undefined;
	}

	// A single direct (non-worktree) write on a dirty tree is preserved, but any
	// concurrent write combination is rejected unless every concurrently running
	// write (and this new one) opts into worktree isolation.
	private concurrentWriteBlockReason(spec: InternalTaskSpec) {
		if (spec.mode !== "write") return undefined;
		const runningWrites = this.runningEntries().filter((entry) => entry.snapshot.mode === "write");
		if (runningWrites.length === 0) return undefined;
		const allIsolated = runningWrites.every((entry) => entry.snapshot.worktree?.isolated) && spec.worktree === true;
		if (!allIsolated) {
			return this.allowWorktrees
				? "Concurrent write tasks require every currently running write task (and this one) to opt into worktree isolation (worktree=true)."
				: "A write worker is already running. Wait for it to finish before starting another write.";
		}
		return undefined;
	}

	private executorBlockReason(spec: InternalTaskSpec) {
		if (spec.executor !== true) return undefined;
		const selection = decodeWorkerModel(resolveModel(spec, this.defaultModel, this.modelProfiles, this.testerModel));
		if (selection.backend !== "opencode") return "Executor MCP requires the OpenCode backend.";
		return executorGateError({ spec, model: selection.model });
	}

	private spawnBlockReason(spec: InternalTaskSpec, cwd: string) {
		if (spec.worktree && !this.allowWorktrees) return "Worktree isolation is unavailable. Workers run in the current working directory.";
		if (this.disposed) return "OpenCode task manager is shut down.";
		if (this.runningCount() >= MAX_RUNNING) return `OpenCode concurrency limit reached (${MAX_RUNNING}).`;
		if (spec.mode === "write") {
			const concurrency = this.concurrentWriteBlockReason(spec);
			if (concurrency) return concurrency;
			const conflict = this.conflictFor(spec, cwd);
			if (conflict) {
				return `Write scope conflicts with running task ${conflict.task.id} "${conflict.task.name}": ${conflict.conflict.left} overlaps ${conflict.conflict.right}`;
			}
		}
		return undefined;
	}

	spawn(spec: InternalTaskSpec, cwd: string) {
		const executorReason = this.executorBlockReason(spec);
		if (executorReason) throw new Error(executorReason);
		const blockReason = this.spawnBlockReason(spec, cwd);
		if (blockReason) throw new Error(blockReason);
		if ((spec.role === "tester" || spec.role === "reviewer") && spec.mode !== "read_only") {
			throw new Error(`Role ${spec.role} requires mode read_only.`);
		}
		if (spec.worktree && spec.mode !== "write") {
			throw new Error("Worktree isolation (worktree=true) requires mode write.");
		}
		const scopes = normalizeScopes(cwd, spec.relevantPaths);
		const selection = decodeWorkerModel(resolveModel(spec, this.defaultModel, this.modelProfiles, this.testerModel));
		if (selection.backend === "collie") {
			const gate = collieGateError({ spec });
			if (gate) throw new Error(gate);
			// Validate the provider/model split before creating a worktree or task
			// entry; malformed Collie routes fail closed with no launch side effect.
			collieModelParts(selection.model);
		}
		const id = `oc-${++this.counter}`;
		const snapshot: TaskSnapshot = {
			id,
			name: spec.name.trim().slice(0, 160) || id,
			mode: spec.mode,
			status: "running",
			objective: spec.objective,
			relevantPaths: [...spec.relevantPaths],
			scopes,
			model: selection.model,
			backend: selection.backend,
			role: spec.role,
			workflowId: spec.workflowId,
			createdAt: Date.now(),
			output: "",
			stderr: "",
			activity: [],
			timedOut: false,
			truncated: false,
			worktree: spec.worktree ? { isolated: true, status: "pending" } : undefined,
		};
		const entry: ManagedTask = {
			snapshot,
			buffer: "",
			stderrBuffer: "",
			settleListeners: new Set(),
			waiters: 0,
			consumed: false,
			delivered: false,
			cancelRequested: false,
		};
		try {
			let childCwd = cwd;
			if (spec.worktree) childCwd = this.prepareWorktree(entry, cwd, scopes);
			entry.childCwd = childCwd;
			// Tester and direct non-worktree write workers get a repository mutation
			// guard. Direct writes additionally use the baseline to enforce declared
			// scopes at close; neither guard ever reverts worker changes.
			const guard = spec.role === "tester"
				? "tester"
				: spec.mode === "write" && !spec.worktree
					? "direct-write"
					: undefined;
			if (guard) {
				const baseline = captureGitFingerprint(cwd);
				if (!baseline) {
					throw new Error(
						guard === "tester"
							? "Tester role requires a Git worktree with a capturable baseline; refusing to spawn without a repository mutation guard."
							: "Direct write workers require a Git worktree with a capturable baseline; refusing to spawn without scope enforcement.",
					);
				}
				entry.baselineFingerprint = baseline;
				entry.cwd = cwd;
				entry.gitGuard = guard;
			}
			this.tasks.set(id, entry);
			this.prune();
			this.start(entry, spec, childCwd);
			this.notify();
			return snapshot;
		} catch (error) {
			this.failSpawn(entry, error);
			throw error;
		}
	}

	async spawnWhenAvailable(spec: InternalTaskSpec, cwd: string, signal?: AbortSignal) {
		if (spec.worktree && !this.allowWorktrees) throw new Error("Worktree isolation is unavailable. Workers run in the current working directory.");
		const executorReason = this.executorBlockReason(spec);
		if (executorReason) throw new Error(executorReason);
		while (true) {
			if (signal?.aborted) throw new Error("Operation was aborted.");
			const reason = this.spawnBlockReason(spec, cwd);
			if (!reason) {
				if (signal?.aborted) throw new Error("Operation was aborted.");
				return this.spawn(spec, cwd);
			}
			if (reason.includes("shut down")) throw new Error(reason);
			await this.waitForChange(signal);
		}
	}

	private waitForChange(signal?: AbortSignal) {
		if (signal?.aborted) return Promise.reject(new Error("Operation was aborted."));
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => listener(), 250);
			timer.unref();
			const listener = () => {
				cleanup();
				resolve();
			};
			const onAbort = () => {
				cleanup();
				reject(new Error("Operation was aborted."));
			};
			const cleanup = () => {
				clearTimeout(timer);
				this.capacityListeners.delete(listener);
				signal?.removeEventListener("abort", onAbort);
			};
			this.capacityListeners.add(listener);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	// A synchronous adapter/spawn failure happens after worktree preparation
	// often enough to require the same cleanup guarantees as a worker failure.
	// Poison the batch before removing the failed task so no later task can join
	// a partially prepared batch. A cleanup failure is retained for the cleanup UI.
	private failSpawn(entry: ManagedTask, error: unknown) {
		const adapter = this.backends[entry.snapshot.backend];
		let agentCleanupError: string | undefined;
		entry.backendCleanupDone = true;
		try {
			agentCleanupError = adapter.cleanupAgent(entry.agentName, entry.preparation);
		} catch (cleanupError) {
			agentCleanupError = processError(cleanupError);
		}
		const wt = entry.worktree;
		if (!wt) {
			this.tasks.delete(entry.snapshot.id);
			this.notify();
			return;
		}
		wt.batch.poisoned = true;
		const failures: string[] = agentCleanupError ? [`worker agent cleanup failed: ${agentCleanupError}`] : [];
		const remove = runGitResult(wt.repoRoot, ["worktree", "remove", "--force", wt.path]);
		if (!remove.ok) {
			failures.push(`git worktree remove failed: ${redactAbsolutePaths(remove.stderr.toString("utf8").trim(), worktreeRedactionPaths(wt)) || "unknown error"}`);
		}
		const prune = runGitResult(wt.repoRoot, ["worktree", "prune"]);
		if (!prune.ok) failures.push("git worktree prune failed");
		const patchCleanupError = this.removePatchFileWithRetry(wt.patchPath);
		if (patchCleanupError) failures.push(patchCleanupError);
		entry.snapshot.status = "error";
		entry.snapshot.error = redactAbsolutePaths(`Worker launch failed: ${processError(error)}`, worktreeRedactionPaths(wt));
		if (failures.length === 0) {
			const index = wt.batch.tasks.indexOf(entry);
			if (index >= 0) wt.batch.tasks.splice(index, 1);
			if (wt.batch.tasks.length === 0) {
				wt.batch.open = false;
				this.worktreeBatches.delete(wt.batch.key);
			}
			this.tasks.delete(entry.snapshot.id);
			this.notify();
			return;
		}
		this.markWorktreeRetained(entry, "cleanup-failed", `${entry.snapshot.error}; cleanup failed: ${failures.join("; ")}`);
		this.finishSettle(entry);
	}

	private cleanupBackend(entry: ManagedTask, adapter: WorkerBackendAdapter) {
		if (entry.backendCleanupDone) return;
		entry.backendCleanupDone = true;
		try {
			const failure = adapter.cleanupAgent(entry.agentName, entry.preparation);
			if (failure) entry.snapshot.error ??= `${adapter.displayName} worker cleanup failed: ${failure}`;
		} catch (error) {
			entry.snapshot.error ??= `${adapter.displayName} worker cleanup failed: ${processError(error)}`;
		}
	}

	private start(entry: ManagedTask, spec: TaskSpec, cwd: string) {
		const prompt = buildWorkerPrompt(spec);
		const thinking = resolveThinkingLevel(spec, this.thinkingLevel);
		// Backend-specific command/args/env/tool-allowlist/agent construction is
		// delegated to the backend adapter; scheduling, snapshot state, output
		// parsing, and Git/worktree handling stay in the manager.
		const adapter = this.backends[entry.snapshot.backend];
		const backendName = adapter.displayName;
		const spawnInput = {
			taskId: entry.snapshot.id,
			spec,
			model: entry.snapshot.model,
			thinking,
			prompt,
			cwd,
		};
		const preparation: BackendPreparation = adapter.prepare(spawnInput);
		entry.preparation = preparation;
		const agentName = preparation.agentName;
		entry.agentName = agentName;
		if (preparation.activity.length > 0) {
			entry.snapshot.activity.push(...preparation.activity);
			if (entry.snapshot.activity.length > MAX_ACTIVITY_ITEMS) entry.snapshot.activity.shift();
		}
		const args = adapter.buildArgs(spawnInput, preparation);
		// Build the child environment from the explicit runtime allowlist. Keep
		// the user's data-home location so CLI auth remains available, while the
		// adapter receives its private per-spawn config preparation separately.
		const workerEnv: NodeJS.ProcessEnv = { ...buildWorkerEnv(), NO_COLOR: "1", FORCE_COLOR: "0" };
		if (process.env.XDG_DATA_HOME !== undefined) workerEnv.XDG_DATA_HOME = process.env.XDG_DATA_HOME;
		const env = adapter.buildEnv(workerEnv, spawnInput, preparation);
		const child = spawn(adapter.binary, args, {
			cwd,
			env,
			detached: os.platform() !== "win32",
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		entry.child = child;

		const timeout = setTimeout(() => {
			entry.snapshot.timedOut = true;
			entry.snapshot.error = `${backendName} worker timed out after ${this.timeoutMs} ms.`;
			killProcessTree(child, "SIGTERM");
			setTimeout(() => { killProcessTree(child, "SIGKILL"); this.cleanupBackend(entry, adapter); }, 5_000).unref();
		}, this.timeoutMs);
		timeout.unref();

		child.stdout?.on("data", (data: Buffer) => this.consumeStdout(entry, data.toString("utf8")));
		child.stderr?.on("data", (data: Buffer) => this.consumeStderr(entry, data.toString("utf8")));

		child.on("error", (error) => {
			entry.snapshot.error = `Failed to start ${backendName} worker: ${processError(error)}`;
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			this.cleanupBackend(entry, adapter);
			if (entry.buffer.trim()) this.consumeLine(entry, entry.buffer);
			entry.buffer = "";
			if (entry.stderrBuffer.trim()) this.consumeStderrLine(entry, entry.stderrBuffer);
			entry.stderrBuffer = "";
			entry.snapshot.exitCode = code ?? 1;
			// Exit-time report normalization: parse stays manager-owned; the
			// backend adapter may normalize the backend-specific report shape
			// before any manager-owned worktree path normalization runs.
			entry.snapshot.report = adapter.normalizeExitReport(parseWorkerReport(entry.snapshot.output));
			if (entry.worktree) {
				// Map worktree-absolute paths in the structured report to
				// repo-relative paths before the handoff consumes the report.
				this.normalizeWorktreeReport(entry);
			}
			entry.child = undefined;
			if (entry.worktree) {
				const failed = entry.cancelRequested || entry.snapshot.timedOut || code !== 0 || entry.snapshot.error !== undefined;
				if (failed) {
					// Cancel/timeout/worker failure: never integrate or auto-revert;
					// the worktree is retained for a later cleanup UI. The retention
					// code is decided here from the terminal cause, never from error text.
					this.resolveStatus(entry, code, backendName);
					this.redactWorktreeDiagnostics(entry);
					const code_: RetentionCode = entry.cancelRequested
						? "cancel"
						: entry.snapshot.timedOut
							? "timeout"
							: "worker-failure";
					this.markWorktreeRetained(
						entry,
						code_,
						entry.snapshot.error ?? `${backendName} worker did not exit cleanly.`,
					);
					this.finishSettle(entry);
				} else {
					void this.finalizeWorktree(entry).then(
						() => {
							this.resolveStatus(entry, code, backendName);
							this.redactWorktreeDiagnostics(entry);
							this.finishSettle(entry);
						},
						(error: unknown) => {
							if (entry.cancelRequested) {
								entry.snapshot.error = undefined;
								this.resolveStatus(entry, code, backendName);
								this.redactWorktreeDiagnostics(entry);
								this.markWorktreeRetained(entry, "cancel", "Worker cancellation requested before integration; isolated patch was not integrated.");
							} else {
								entry.snapshot.error = processError(error);
								entry.snapshot.status = "error";
								this.redactWorktreeDiagnostics(entry);
								this.markWorktreeRetained(entry, retentionCodeOf(error), entry.snapshot.error);
							}
							this.finishSettle(entry);
						},
					);
				}
				return;
			}
			this.resolveStatus(entry, code, backendName);
			this.finishSettle(entry);
		});
	}

	private resolveStatus(entry: ManagedTask, code: number | null, backendName: string) {
		const comparison = entry.baselineFingerprint && entry.cwd
			? compareGitFingerprint(entry.baselineFingerprint, entry.cwd)
			: undefined;
		if (entry.gitGuard === "direct-write" && comparison?.error) {
			entry.snapshot.status = "error";
			entry.snapshot.error = `Direct write worker scope enforcement failed: ${comparison.error}; files were NOT reverted.`;
		} else if (entry.gitGuard === "direct-write" && comparison?.mutated) {
			const scopes = entry.snapshot.scopes;
			const outOfScope = comparison.changedPaths.filter((relative) => {
				const absolute = path.resolve(entry.cwd!, relative);
				return !scopes.some((scope) => pathWithinScope(absolute, scope));
			});
			if (outOfScope.length > 0) {
				entry.snapshot.status = "error";
				entry.snapshot.error = `Direct write worker changed out-of-scope path(s): ${outOfScope.join(", ")}; files were NOT reverted. Post-run detection is not a sandbox; outside-repo and ignored side effects are not prevented.`;
			} else if (comparison.changedPaths.length === 0) {
				entry.snapshot.status = "error";
				entry.snapshot.error = "Direct write worker changed the repository, but the changed path could not be identified; files were NOT reverted.";
			}
		} else if (entry.gitGuard === "tester" && comparison) {
			const mutation = comparison.error ?? (comparison.mutated ? detectMutationMessage(entry.baselineFingerprint!, comparison) : undefined);
			if (mutation) {
				entry.snapshot.status = "error";
				entry.snapshot.error = `Tester worker mutated the repository: ${mutation}. Bash can mutate during execution; outside-repo and ignored side effects are not prevented.`;
			}
		}
		if (entry.snapshot.status === "running" && entry.cancelRequested) entry.snapshot.status = "cancelled";
		else if (entry.snapshot.status === "running" && (entry.snapshot.timedOut || code !== 0 || entry.snapshot.error)) {
			entry.snapshot.status = "error";
			entry.snapshot.error ??= `${backendName} worker exited with code ${code ?? 1}.`;
		} else if (entry.snapshot.status === "running") entry.snapshot.status = "done";
	}

	private finishSettle(entry: ManagedTask) {
		// Record the settle timestamp at the terminal point so worktree tasks
		// capture it after (not before) worktree finalization completes.
		entry.snapshot.settledAt = Date.now();
		if (entry.worktree) this.maybeCloseBatch(entry.worktree.batch);
		for (const listener of entry.settleListeners) listener();
		entry.settleListeners.clear();
		this.notify();
	}

	private maybeCloseBatch(batch: WorktreeBatch) {
		if (batch.tasks.every((task) => task.snapshot.status !== "running")) {
			batch.open = false;
			this.worktreeBatches.delete(batch.key);
		}
	}

	// Spawn-time worktree setup: join or open a per-repo batch, require a clean
	// root for the batch's first task, capture the shared base HEAD, and create
	// the detached task worktree under an OS-temp repo-hash directory while
	// preserving the cwd-relative subdirectory for the child.
	private prepareWorktree(entry: ManagedTask, cwd: string, scopes: string[]) {
		const toplevel = runGit(cwd, ["rev-parse", "--show-toplevel"]);
		if (!toplevel) throw new Error("Worktree isolation requires a Git repository root.");
		const repoRoot = path.resolve(toplevel.toString("utf8").trim());
		const key = pathForScopeComparison(repoRoot);
		const baseDir = worktreeRootDir(repoRoot);
		let batch = this.worktreeBatches.get(key);
		if (!batch || !batch.open) {
			const clean = captureGitFingerprint(repoRoot);
			if (!clean) {
				throw new Error("Worktree isolation requires a capturable Git root fingerprint.");
			}
			if (!isCleanFingerprint(clean)) {
				throw new Error("The first worktree task in a batch requires a clean Git root; refusing to start isolation on a dirty tree.");
			}
			const headBuffer = runGit(repoRoot, ["rev-parse", "HEAD"]);
			if (!headBuffer) throw new Error("Unable to capture the repository base HEAD for worktree isolation.");
			batch = {
				repoRoot,
				key,
				baseHead: headBuffer.toString("utf8").trim(),
				expectedFingerprint: clean,
				integratedPatchBuffers: [],
				tasks: [],
				poisoned: false,
				open: true,
			};
			this.worktreeBatches.set(key, batch);
		}
		if (batch.poisoned) throw new Error("Worktree batch is poisoned; refusing to start another isolated worker in it.");
		const wtPath = path.join(baseDir, entry.snapshot.id);
		try {
			mkdirSync(baseDir, { recursive: true });
			const added = runGitResult(repoRoot, ["worktree", "add", "--detach", wtPath, batch.baseHead]);
			if (!added.ok) {
				const stderr = redactAbsolutePaths(
					added.stderr.toString("utf8").trim(),
					[baseDir, wtPath],
				);
				throw new Error(`Failed to create isolated worktree: ${stderr || "git worktree add failed"}`);
			}
			const relCwd = path.relative(repoRoot, cwd);
			const childCwd = relCwd ? path.join(wtPath, relCwd) : wtPath;
			entry.worktree = {
				path: wtPath,
				repoRoot,
				childCwd,
				baseHead: batch.baseHead,
				scopes,
				batch,
			};
			entry.snapshot.worktree = { isolated: true, baseHead: batch.baseHead, status: "pending" };
			batch.tasks.push(entry);
			mkdirSync(childCwd, { recursive: true });
			return childCwd;
		} catch (error) {
			batch.poisoned = true;
			if (batch.tasks.length === 0) {
				batch.open = false;
				this.worktreeBatches.delete(batch.key);
			}
			throw error;
		}
	}

	// Validate the isolated changes and enqueue integration through the
	// per-repo ID-ordered batch queue. Any rejection retains the worktree.
	private async finalizeWorktree(entry: ManagedTask): Promise<void> {
		this.throwIfCancelled(entry, "before worktree finalization");
		const wt = entry.worktree!;
		const headResult = runGitResult(wt.path, ["rev-parse", "HEAD"]);
		if (!headResult.ok) {
			throw new Error(`Unable to read worker worktree HEAD: ${headResult.stderr.toString("utf8").trim() || "git rev-parse failed"}`);
		}
		const head = headResult.stdout.toString("utf8").trim();
		if (head !== wt.baseHead) {
			throw new RetentionError("commit", `Worker moved its worktree HEAD (git commit detected); expected ${wt.baseHead.slice(0, 12)} but found ${head.slice(0, 12)}.`);
		}
		const add = runGitResult(wt.path, ["add", "-A"]);
		if (!add.ok) {
			throw new Error(`Failed to stage isolated worktree changes: ${add.stderr.toString("utf8").trim() || "git add failed"}`);
		}
		const raw = runGitResult(wt.path, ["diff", "--cached", "--raw"]);
		if (!raw.ok) throw new Error("Failed to inspect isolated worktree changes.");
		for (const line of raw.stdout.toString("utf8").split("\n")) {
			const fields = line.trim().split(/\s+/);
			if (fields.length >= 2 && fields[0].startsWith(":")) {
				const oldMode = fields[0].slice(1);
				const newMode = fields[1];
				if (oldMode === "160000" || newMode === "160000") {
					throw new RetentionError("gitlink", "Isolated worktree contains submodule/gitlink changes, which are not safely supported; rejecting integration.");
				}
			}
		}
		const names = runGitResult(wt.path, ["diff", "--cached", "--name-only", "-z"]);
		if (!names.ok) throw new Error("Failed to enumerate isolated worktree changes.");
		const changedPaths = splitNul(names.stdout);
		const outOfScope: string[] = [];
		for (const rel of changedPaths) {
			const originalAbs = path.resolve(wt.repoRoot, rel);
			const inside = wt.scopes.some((scope) => pathWithinScope(originalAbs, scope));
			if (!inside) outOfScope.push(rel);
		}
		if (outOfScope.length > 0) {
			wt.changedPaths = changedPaths;
			wt.conflictPaths = outOfScope;
			throw new RetentionError("out-of-scope", `Out-of-scope change detected: ${outOfScope.join(", ")}; refusing to integrate.`);
		}
		const patch = runGitResult(wt.path, ["diff", "--cached", "--binary", "--full-index", "--no-color"]);
		if (!patch.ok) throw new Error("Failed to generate the isolated change patch.");
		wt.patchBuffer = patch.stdout;
		wt.changedPaths = changedPaths;
		if (patch.stdout.length > 0) {
			try {
				wt.patchPath = createPatchArchive(worktreeRootDir(wt.repoRoot), patch.stdout);
			} catch (error) {
				throw new RetentionError("integration-conflict", `Failed to securely create the isolated patch archive: ${processError(error)}`);
			}
		}
		this.throwIfCancelled(entry, "before entering the integration queue");
		await this.enqueueIntegration(wt.batch, entry);
	}

	// Wait until every lower-ID batch task has settled (its worker process
	// finished and its status is terminal, which for successful tasks means its
	// own integration already completed), then apply in ID order. The wait is
	// bounded by the configured worker timeout plus a small integration grace so
	// an unkillable/lower-ID task cannot make a finalized higher-ID task poll
	// forever; on expiry a deterministic integration-order timeout is thrown and
	// the caller retains the current worktree and settles the task as an error.
	private async waitForBatchOrder(batch: WorktreeBatch, entry: ManagedTask) {
		const rank = batch.tasks.indexOf(entry);
		const deadline = Date.now() + this.timeoutMs + INTEGRATION_ORDER_GRACE_MS;
		while (true) {
			this.throwIfCancelled(entry, "while waiting for integration order");
			if (Date.now() > deadline) {
				throw new RetentionError(
					"integration-conflict",
					`Integration-order wait timed out after ${this.timeoutMs + INTEGRATION_ORDER_GRACE_MS} ms; a lower-ID task did not settle, refusing to integrate out of order.`,
				);
			}
			const lowerPending = batch.tasks.slice(0, Math.max(0, rank)).some((task) => task.snapshot.status === "running");
			if (!lowerPending) return;
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		}
	}

	private async enqueueIntegration(batch: WorktreeBatch, entry: ManagedTask): Promise<void> {
		await this.waitForBatchOrder(batch, entry);
		this.throwIfCancelled(entry, "before the integration check");
		this.applyPatch(entry);
	}

	private throwIfCancelled(entry: ManagedTask, phase: string): void {
		if (entry.cancelRequested) {
			throw new RetentionError("cancel", `Worker cancellation requested ${phase}; isolated patch was not integrated.`);
		}
	}

	// Rebuild the expected postcondition in a disposable detached worktree. The
	// shadow always starts at the immutable batch base and replays only manager-
	// held, successfully integrated buffers plus the current buffer. Its path
	// never enters a snapshot or an error; cleanup is mandatory and any cleanup
	// failure aborts before the live root is touched.
	private shadowPostcondition(
		repoRoot: string,
		baseHead: string,
		patches: readonly Buffer[],
		expectedHeadRef?: string,
	): GitFingerprint {
		const baseDir = worktreeRootDir(repoRoot);
		const shadowPath = path.join(baseDir, `.shadow-${randomBytes(24).toString("hex")}`);
		let added = false;
		try {
			mkdirSync(baseDir, { recursive: true });
			const add = runGitResult(repoRoot, ["worktree", "add", "--detach", shadowPath, baseHead]);
			if (!add.ok) {
				throw new RetentionError(
					"integration-conflict",
					`Unable to create the integration shadow worktree: ${redactAbsolutePaths(add.stderr.toString("utf8").trim(), [baseDir, shadowPath]) || "git worktree add failed"}`,
				);
			}
			added = true;
			for (const patch of patches) {
				if (patch.length === 0) continue;
				const check = runGitResult(shadowPath, ["apply", "--check", "-"], patch);
				if (!check.ok) {
					throw new RetentionError(
						"integration-conflict",
						`Unable to reproduce the expected integration state in the shadow worktree: ${redactAbsolutePaths(check.stderr.toString("utf8").trim(), [baseDir, shadowPath]) || "patch does not apply cleanly"}`,
					);
				}
				const apply = runGitResult(shadowPath, ["apply", "-"], patch);
				if (!apply.ok) {
					throw new RetentionError(
						"integration-conflict",
						`Unable to reproduce the expected integration state in the shadow worktree: ${redactAbsolutePaths(apply.stderr.toString("utf8").trim(), [baseDir, shadowPath]) || "patch apply failed"}`,
					);
				}
			}
			const fingerprint = captureGitFingerprint(shadowPath);
			if (!fingerprint || fingerprint.headOid !== baseHead) {
				throw new RetentionError("integration-conflict", "Unable to capture the expected integration fingerprint from the shadow worktree; refusing to apply.");
			}
			// The shadow is intentionally detached. Normalize only this metadata to
			// the live root's retained ref so exact comparison also rejects a
			// same-commit branch switch at the root.
			return expectedHeadRef === undefined
				? fingerprint
				: { ...fingerprint, headRef: expectedHeadRef };
		} finally {
			if (added) {
				const remove = runGitResult(repoRoot, ["worktree", "remove", "--force", shadowPath]);
				const prune = runGitResult(repoRoot, ["worktree", "prune"]);
				if (!remove.ok || !prune.ok) {
					throw new RetentionError(
						"integration-conflict",
						"Integration shadow worktree cleanup failed; refusing to apply the patch.",
					);
				}
			}
		}
	}

	// Apply at the repository root without staging/root reset/stash. The exact
	// expected fingerprint is calculated in a detached shadow first, then the
	// root is checked before and after `git apply`. A mismatch poisons the batch;
	// the root is deliberately never auto-reverted.
	private applyPatch(entry: ManagedTask): void {
		this.throwIfCancelled(entry, "immediately before root integration");
		const wt = entry.worktree!;
		const batch = wt.batch;
		if (batch.poisoned) {
			throw new RetentionError("integration-conflict", "Batch integration aborted after an external root mutation; refusing to apply.");
		}
		const patch = wt.patchBuffer ?? Buffer.alloc(0);
		let expected: GitFingerprint;
		try {
			expected = this.shadowPostcondition(
				wt.repoRoot,
				batch.baseHead,
				[...batch.integratedPatchBuffers, patch],
				batch.expectedFingerprint.headRef,
			);
		} catch (error) {
			batch.poisoned = true;
			if (error instanceof RetentionError) throw error;
			throw new RetentionError("integration-conflict", `Unable to calculate the expected integration postcondition: ${processError(error)}`);
		}

		const before = captureGitFingerprint(wt.repoRoot);
		if (!before) {
			batch.poisoned = true;
			throw new RetentionError("integration-conflict", "Unable to capture the repository root fingerprint before integration; refusing to apply.");
		}
		if (!sameGitFingerprint(before, batch.expectedFingerprint)) {
			batch.poisoned = true;
			throw new RetentionError("integration-conflict", "External mutation detected at the repository root; integration aborted for this batch and its remaining tasks.");
		}
		if (patch.length > 0) {
			this.throwIfCancelled(entry, "before git apply --check");
			const check = runGitResult(wt.repoRoot, ["apply", "--check", "-"], patch);
			if (!check.ok) {
				batch.poisoned = true;
				throw new RetentionError("integration-conflict", `git apply --check rejected the isolated patch: ${check.stderr.toString("utf8").trim() || "patch does not apply cleanly"}`);
			}
			// --check executes a separate Git process, so re-capture immediately
			// afterward and require the complete expected precondition again.
			const checkedFingerprint = captureGitFingerprint(wt.repoRoot);
			if (!checkedFingerprint || !sameGitFingerprint(checkedFingerprint, batch.expectedFingerprint)) {
				batch.poisoned = true;
				throw new RetentionError("integration-conflict", "External mutation detected between git apply --check and root integration; batch integration aborted.");
			}
			this.throwIfCancelled(entry, "before root git apply");
			const apply = runGitResult(wt.repoRoot, ["apply", "-"], patch);
			if (!apply.ok) {
				batch.poisoned = true;
				throw new RetentionError("integration-conflict", `git apply failed: ${apply.stderr.toString("utf8").trim() || "apply error"}`);
			}
		}

		// This postcondition is checked even for a no-op patch. It detects HEAD
		// movement, extra/same-path root mutation, and any apply-time mutation;
		// there is intentionally no automatic revert on failure.
		const after = captureGitFingerprint(wt.repoRoot);
		if (!after || !sameGitFingerprint(after, expected)) {
			batch.poisoned = true;
			throw new RetentionError("integration-conflict", "Repository post-integration fingerprint mismatch; batch integration is halted and the root was NOT reverted.");
		}
		batch.expectedFingerprint = after;
		batch.integratedPatchBuffers.push(Buffer.from(patch));
		this.completeIntegration(entry);
	}

	// Integration already succeeded; only worktree and temporary patch-file
	// cleanup remain. A cleanup failure must not undo the integration and is
	// represented on the snapshot's worktree metadata (cleanup-failed) and kept
	// in the retained-worktree registry (rootIntegrated=true) so the discard API
	// can still remove the leftover worktree.
	private completeIntegration(entry: ManagedTask): void {
		const wt = entry.worktree!;
		const remove = runGitResult(wt.repoRoot, ["worktree", "remove", "--force", wt.path]);
		runGitResult(wt.repoRoot, ["worktree", "prune"]);
		const patchCleanupError = this.removePatchFileWithRetry(wt.patchPath);
		const info = entry.snapshot.worktree as WorktreeSnapshotInfo | undefined;
		if (info) {
			info.changedPaths = wt.changedPaths;
			if (remove.ok && !patchCleanupError) {
				info.status = "integrated";
				this.retainedWorktrees.delete(entry.snapshot.id);
			} else {
				const failures: string[] = [];
				if (!remove.ok) {
					const stderr = redactAbsolutePaths(remove.stderr.toString("utf8").trim(), worktreeRedactionPaths(wt));
					failures.push(`git worktree remove failed: ${stderr || "unknown error"}`);
				}
				if (patchCleanupError) failures.push(patchCleanupError);
				info.status = "cleanup-failed";
				info.error = redactAbsolutePaths(`Integrated, but cleanup failed: ${failures.join("; ")}`, worktreeRedactionPaths(wt));
				this.retainedWorktrees.set(entry.snapshot.id, {
					taskId: entry.snapshot.id,
					name: entry.snapshot.name,
					path: wt.path,
					repoRoot: wt.repoRoot,
					baseHead: wt.baseHead,
					scopes: wt.scopes.map((scope) => this.repoRelative(wt.repoRoot, scope)),
					changedPaths: [...(wt.changedPaths ?? [])],
					conflictPaths: [],
					status: "done",
					error: info.error,
					createdAt: entry.snapshot.createdAt,
					patchPath: wt.patchPath,
					patchBuffer: undefined,
					kind: "cleanup-failed",
					retryable: false,
					rootIntegrated: true,
				});
			}
		}
	}

	// Safely remove the temporary patch file after successful integration.
	// A missing patch file (never written, e.g. an empty patch) is not an error.
	// Returns an error message on unlink failure, or undefined on success; the
	// already-applied root change is never undone regardless of the outcome.
	private removePatchFile(patchPath?: string): string | undefined {
		if (!patchPath) return undefined;
		try {
			// Never unlink a substituted archive path. lstat deliberately rejects
			// symlinks, while nlink=1 rejects hardlink substitutions.
			validatePatchStats(lstatSync(patchPath), "cleanup");
			unlinkSync(patchPath);
			return undefined;
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err && err.code === "ENOENT") return undefined;
			return `temporary patch file cleanup failed: ${processError(error)}`;
		}
	}

	// Bounded Windows-safe patch unlink: retries a bounded number of times with a
	// short synchronous wait to ride out transient file locks left by git
	// subprocesses before giving up. Returns an error message on persistent
	// failure, or undefined on success.
	private removePatchFileWithRetry(patchPath?: string): string | undefined {
		let lastError: unknown;
		for (let attempt = 0; attempt < 6; attempt++) {
			const error = this.removePatchFile(patchPath);
			if (error === undefined) return undefined;
			lastError = error;
			if (os.platform() === "win32" && attempt < 5) {
				sleepSync(120);
			}
		}
		return String(lastError);
	}

	// Map absolute file paths under the task's worktree to repo-relative paths
	// in the structured report before any downstream handoff consumes them.
	// Relative files and absolute paths outside the worktree remain unchanged.
	private normalizeWorktreeReport(entry: ManagedTask) {
		const wt = entry.worktree;
		const report = entry.snapshot.report;
		if (!wt || !report) return;
		const normalized: string[] = [];
		for (const file of report.files) {
			if (!path.isAbsolute(file)) {
				normalized.push(file);
				continue;
			}
			const relative = path.relative(wt.path, path.resolve(file));
			if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
				normalized.push(file);
				continue;
			}
			normalized.push(relative.split(path.sep).join(path.posix.sep));
		}
		report.files = normalized;
	}

	// Redact absolute temp worktree/state/patch paths from every
	// model/user-facing surface of a worktree task's snapshot: raw output,
	// activity, error, stderr, and the structured report. This runs after the
	// report has been normalized to repo-relative paths and before settle
	// listeners are notified, so opencode_check/opencode_output and the
	// taskResultText raw-output fallback can never expose the OS temp worktree
	// layout. The retained WorktreeRuntime path and retained-worktree registry
	// are untouched and remain usable for cleanup/integration. Non-worktree
	// output is never altered.
	private redactWorktreeDiagnostics(entry: ManagedTask) {
		const wt = entry.worktree;
		if (!wt) return;
		const paths = worktreeRedactionPaths(wt);
		entry.snapshot.output = redactAbsolutePaths(entry.snapshot.output, paths);
		entry.snapshot.activity = entry.snapshot.activity.map((item) => redactAbsolutePaths(item, paths));
		if (entry.snapshot.error) entry.snapshot.error = redactAbsolutePaths(entry.snapshot.error, paths);
		entry.snapshot.stderr = redactAbsolutePaths(entry.snapshot.stderr, paths);
		const report = entry.snapshot.report;
		if (report) {
			report.summary = redactAbsolutePaths(report.summary, paths);
			report.files = report.files.map((file) => redactAbsolutePaths(file, paths));
			report.findings = report.findings.map((item) => redactAbsolutePaths(item, paths));
			report.unresolved = report.unresolved.map((item) => redactAbsolutePaths(item, paths));
		}
	}

	// Retain (never auto-delete) a conflicted/failed/cancelled/timed-out
	// worktree along with its error for a later cleanup UI. The retention kind
	// is supplied explicitly by the caller (never derived from error-text
	// substrings); the internal RetentionCode is mapped onto the public
	// WorktreeRetentionKind while preserving retryable derivation.
	private markWorktreeRetained(entry: ManagedTask, code: RetentionCode, reason: string) {
		const info = entry.snapshot.worktree;
		if (info) {
			info.status = "retained";
			info.error = reason;
		}
		const wt = entry.worktree;
		if (!wt) return;
		const kind = retentionKindOf(code);
		this.retainedWorktrees.set(entry.snapshot.id, {
			taskId: entry.snapshot.id,
			name: entry.snapshot.name,
			path: wt.path,
			repoRoot: wt.repoRoot,
			baseHead: wt.baseHead,
			baseHeadRef: wt.batch.expectedFingerprint.headRef,
			scopes: wt.scopes.map((scope) => this.repoRelative(wt.repoRoot, scope)),
			changedPaths: [...(wt.changedPaths ?? [])],
			conflictPaths: [...(wt.conflictPaths ?? [])],
			status: entry.snapshot.status,
			error: reason,
			createdAt: entry.snapshot.createdAt,
			patchPath: wt.patchPath,
			patchBuffer: code === "post-integration-fingerprint" ? undefined : wt.patchBuffer,
			kind,
			retryable: kind === "integration-failure",
			rootIntegrated: code === "post-integration-fingerprint",
		});
	}

	// Convert an absolute path to a POSIX-separated repo-relative path for the
	// public view, falling back to the input when it escapes the repository.
	// A path equal to the repo root itself is rendered as "." so the public
	// RetainedWorktreeView.scopes never exposes the absolute repo root.
	private repoRelative(repoRoot: string, abs: string): string {
		const rel = path.relative(repoRoot, abs);
		if (rel === "") return ".";
		return rel.split(path.sep).join(path.posix.sep);
	}

	// Build the serializable, temp-path-free view for a retained worktree.
	private retainedView(retained: RetainedWorktree): RetainedWorktreeView {
		return {
			taskId: retained.taskId,
			name: retained.name,
			status: retained.status,
			error: retained.error,
			repo: path.basename(retained.repoRoot),
			baseHead: retained.baseHead.slice(0, 12),
			scopes: [...retained.scopes],
			changedPaths: [...retained.changedPaths],
			conflictPaths: [...retained.conflictPaths],
			createdAt: retained.createdAt,
			patchAvailable: retained.patchBuffer !== undefined && retained.patchBuffer.length > 0,
			retryable: retained.retryable,
			rootIntegrated: retained.rootIntegrated,
			kind: retained.kind,
		};
	}

	private consumeStdout(entry: ManagedTask, chunk: string) {
		entry.buffer += chunk;
		const lines = entry.buffer.split("\n");
		entry.buffer = lines.pop() ?? "";
		for (const line of lines) this.consumeLine(entry, line);
		this.notify();
	}

	private consumeStderr(entry: ManagedTask, chunk: string) {
		const appended = boundedAppend(entry.snapshot.stderr, chunk);
		entry.snapshot.stderr = appended.text;
		entry.snapshot.truncated ||= appended.truncated;
		entry.stderrBuffer += chunk;
		const lines = entry.stderrBuffer.split("\n");
		entry.stderrBuffer = lines.pop() ?? "";
		for (const line of lines) this.consumeStderrLine(entry, line);
		// Keep the raw stderr channel byte-for-byte bounded while decoding only
		// complete NDJSON records into activity labels.
		this.notify();
	}

	private consumeStderrLine(entry: ManagedTask, line: string) {
		if (!line.trim()) return;
		const adapter = this.backends[entry.snapshot.backend];
		for (const item of adapter.decodeStderrChunk(`${line}\n`).activity) {
			entry.snapshot.activity.push(item);
			if (entry.snapshot.activity.length > MAX_ACTIVITY_ITEMS) entry.snapshot.activity.shift();
		}
	}

	private consumeLine(entry: ManagedTask, line: string) {
		if (!line.trim()) return;
		let event: Record<string, unknown> | undefined;
		try {
			const parsed: unknown = JSON.parse(line);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) event = parsed as Record<string, unknown>;
		} catch {
			// Workers may emit a plain diagnostic line before JSON events.
		}
		// Backend-specific stdout decoding (raw-line retention, output-text
		// extraction, activity labels) lives in the backend adapter; the manager
		// only applies the decoded result to bounded snapshot storage.
		const adapter = this.backends[entry.snapshot.backend];
		const decoded = adapter.decodeStdoutLine(line, event);
		if (decoded.output !== undefined) {
			const appended = boundedAppend(entry.snapshot.output, decoded.output);
			entry.snapshot.output = appended.text;
			entry.snapshot.truncated ||= appended.truncated;
		}
		for (const item of decoded.activity) {
			entry.snapshot.activity.push(item);
			if (entry.snapshot.activity.length > MAX_ACTIVITY_ITEMS) entry.snapshot.activity.shift();
		}
		if (event) {
			const usage = extractUsageFromEvent(event);
			if (usage) {
				entry.snapshot.usage = mergeUsage(entry.snapshot.usage, usage);
			}
		}
	}

	get(id: string) {
		return this.tasks.get(id)?.snapshot;
	}

	list() {
		return [...this.tasks.values()].map((entry) => entry.snapshot);
	}

	private waitOne(entry: ManagedTask, signal?: AbortSignal) {
		if (entry.snapshot.status !== "running") return Promise.resolve();
		if (signal?.aborted) return Promise.reject(new Error("Wait was aborted; workers keep running."));
		return new Promise<void>((resolve, reject) => {
			const listener = () => {
				cleanup();
				resolve();
			};
			const onAbort = () => {
				cleanup();
				reject(new Error("Wait was aborted; workers keep running."));
			};
			const cleanup = () => {
				entry.settleListeners.delete(listener);
				signal?.removeEventListener("abort", onAbort);
			};
			entry.settleListeners.add(listener);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	async wait(ids: string[], signal?: AbortSignal, consume = true) {
		const entries = [...new Set(ids)].map((id) => {
			const entry = this.tasks.get(id);
			if (!entry) throw new Error(`Unknown OpenCode task id: ${id}`);
			return entry;
		});
		for (const entry of entries) entry.waiters++;
		try {
			await Promise.all(entries.map((entry) => this.waitOne(entry, signal)));
			if (consume) for (const entry of entries) entry.consumed = true;
			return entries.map((entry) => entry.snapshot);
		} finally {
			for (const entry of entries) entry.waiters = Math.max(0, entry.waiters - 1);
		}
	}

	async cancel(ids: string[]) {
		const unique = [...new Set(ids)];
		for (const id of unique) {
			const entry = this.tasks.get(id);
			if (!entry) throw new Error(`Unknown OpenCode task id: ${id}`);
			entry.consumed = true;
			if (entry.snapshot.status !== "running") continue;
			entry.cancelRequested = true;
			if (entry.child) {
				killProcessTree(entry.child, "SIGTERM");
				setTimeout(() => entry.child && killProcessTree(entry.child, "SIGKILL"), 5_000).unref();
			}
		}
		return this.wait(unique, undefined, true);
	}

	drainDeliverable() {
		const ready: TaskSnapshot[] = [];
		for (const entry of this.tasks.values()) {
			if (
				entry.snapshot.status !== "running" &&
				!entry.snapshot.workflowId &&
				!entry.consumed &&
				!entry.delivered &&
				entry.waiters === 0
			) {
				entry.delivered = true;
				ready.push(entry.snapshot);
			}
		}
		return ready;
	}

	private prune() {
		if (this.tasks.size < MAX_TRACKED) return;
		const settled = [...this.tasks.values()]
			.filter((entry) => entry.snapshot.status !== "running")
			.filter((entry) => !this.retainedWorktrees.has(entry.snapshot.id))
			.sort((a, b) => (a.snapshot.settledAt ?? 0) - (b.snapshot.settledAt ?? 0));
		while (this.tasks.size >= MAX_TRACKED && settled.length > 0) {
			const entry = settled.shift();
			if (entry) this.tasks.delete(entry.snapshot.id);
		}
	}

	// Public serializable list of every retained (never auto-deleted) worktree
	// still held by this session. No absolute temp path is exposed.
	listRetainedWorktrees(): RetainedWorktreeView[] {
		return [...this.retainedWorktrees.values()].map((retained) => this.retainedView(retained));
	}

	// Public serializable detail view of one retained worktree.
	getRetainedWorktree(taskId: string): RetainedWorktreeView {
		const retained = this.retainedWorktrees.get(taskId);
		if (!retained) throw new Error(`No retained worktree found for task ${taskId}.`);
		return this.retainedView(retained);
	}

	// Same-repo running/batch guard shared by retry and discard. Returns the
	// reason it is blocked, or undefined when no task is running or batch is open
	// for the given repository root (compared case-insensitively on Windows).
	private sameRepoActivityBlock(repoRoot: string): string | undefined {
		const key = pathForScopeComparison(repoRoot);
		for (const entry of this.tasks.values()) {
			if (entry.snapshot.status !== "running") continue;
			let entryRepo = entry.worktree?.repoRoot;
			if (!entryRepo && entry.childCwd) {
				const top = runGit(entry.childCwd, ["rev-parse", "--show-toplevel"]);
				if (top) entryRepo = path.resolve(top.toString("utf8").trim());
			}
			if (entryRepo && pathForScopeComparison(entryRepo) === key) {
				return `Cannot modify retained worktree while task ${entry.snapshot.id} "${entry.snapshot.name}" is running in the same repository.`;
			}
		}
		if (this.worktreeBatches.has(key)) {
			return "Cannot modify retained worktree while a worktree batch is still open in the same repository.";
		}
		return undefined;
	}

	// User-driven retry of a retained integration failure. Only current-session
	// retained entries whose patch was previously validated and whose root was
	// not integrated are eligible. To keep retry simple and fail closed, the
	// root must be clean and still point at the retained original base HEAD.
	// The expected postcondition is independently replayed in a detached shadow.
	retryRetainedWorktree(taskId: string): RetainedWorktreeView {
		if (this.disposed) throw new Error("OpenCode task manager is shut down.");
		const retained = this.retainedWorktrees.get(taskId);
		if (!retained) throw new Error(`No retained worktree found for task ${taskId}.`);
		if (!retained.retryable || retained.kind !== "integration-failure") {
			throw new Error(
				`Worktree for task ${taskId} is not retryable (kind=${retained.kind}); only current-session integration failures with a previously validated patch and no root integration can be retried.`,
			);
		}
		if (retained.rootIntegrated) {
			throw new Error(`Worktree for task ${taskId} is already integrated at the root; retry would double-apply.`);
		}
		if (retained.patchBuffer === undefined || retained.patchBuffer.length === 0) {
			throw new Error(`No validated patch is available to retry task ${taskId}.`);
		}
		const block = this.sameRepoActivityBlock(retained.repoRoot);
		if (block) throw new Error(block);

		const before = captureGitFingerprint(retained.repoRoot);
		if (!before) {
			throw new Error("Unable to capture the repository root fingerprint before retry.");
		}
		if (!isCleanFingerprint(before)) {
			throw new Error("Retry requires a clean repository root; refusing to apply the retained patch.");
		}
		if (before.headOid !== retained.baseHead || before.headRef !== retained.baseHeadRef) {
			throw new Error("Retry requires the repository HEAD to match the retained original base HEAD; refusing to apply.");
		}
		// The retained archive is intentionally never read or rewritten. It may
		// have been changed by an external actor; the immutable manager buffer is
		// the only input accepted by Git.
		let expected: GitFingerprint;
		try {
			expected = this.shadowPostcondition(retained.repoRoot, retained.baseHead, [retained.patchBuffer], retained.baseHeadRef);
		} catch (error) {
			throw new Error(`Retry rejected: unable to calculate the expected postcondition: ${processError(error)}`);
		}
		const check = runGitResult(retained.repoRoot, ["apply", "--check", "-"], retained.patchBuffer);
		if (!check.ok) {
			throw new Error(
				`Retry rejected: the patch no longer applies; git apply --check reported: ${redactAbsolutePaths(check.stderr.toString("utf8").trim(), [retained.path, retained.patchPath]) || "patch does not apply cleanly"}`,
			);
		}
		const afterCheck = captureGitFingerprint(retained.repoRoot);
		if (!afterCheck || !sameGitFingerprint(afterCheck, before)) {
			throw new Error("Repository fingerprint changed between pre-check and apply; retry aborted without applying.");
		}
		const apply = runGitResult(retained.repoRoot, ["apply", "-"], retained.patchBuffer);
		if (!apply.ok) {
			throw new Error(
				`Retry git apply failed: ${redactAbsolutePaths(apply.stderr.toString("utf8").trim(), [retained.path, retained.patchPath]) || "apply error"}`,
			);
		}
		const postApply = captureGitFingerprint(retained.repoRoot);
		if (!postApply || !sameGitFingerprint(postApply, expected)) {
			throw new Error("Retry post-integration fingerprint mismatch; the root was NOT reverted and retry remains refused until the root is clean at the original base HEAD.");
		}

		// Success: update the original snapshot to done/integrated and clear the
		// integration error, then remove/prune the worktree and patch.
		const entry = this.tasks.get(taskId);
		if (entry) {
			entry.snapshot.status = "done";
			entry.snapshot.error = undefined;
			const info = entry.snapshot.worktree as WorktreeSnapshotInfo | undefined;
			if (info) {
				info.status = "integrated";
				info.error = undefined;
				info.changedPaths = [...retained.changedPaths];
			}
		}
		return this.completeRetryCleanup(retained);
	}

	// After a successful retry apply, remove/prune the worktree and patch file.
	// On cleanup failure the integration is preserved (rootIntegrated=true) and
	// the entry is retained as cleanup-failed so the discard API can finish it.
	private completeRetryCleanup(retained: RetainedWorktree): RetainedWorktreeView {
		const remove = runGitResult(retained.repoRoot, ["worktree", "remove", "--force", retained.path]);
		runGitResult(retained.repoRoot, ["worktree", "prune"]);
		const patchCleanupError = this.removePatchFileWithRetry(retained.patchPath);
		if (remove.ok && !patchCleanupError) {
			this.retainedWorktrees.delete(retained.taskId);
			// Transient view of the now-integrated entry (it is no longer retained).
			return this.retainedView({
				...retained,
				status: "done",
				error: undefined,
				retryable: false,
				rootIntegrated: true,
				patchBuffer: undefined,
			});
		}
		const failures: string[] = [];
		if (!remove.ok) {
			const stderr = redactAbsolutePaths(remove.stderr.toString("utf8").trim(), [retained.path, retained.patchPath]);
			failures.push(`git worktree remove failed: ${stderr || "unknown error"}`);
		}
		if (patchCleanupError) failures.push(patchCleanupError);
		const error = redactAbsolutePaths(`Integrated, but cleanup failed: ${failures.join("; ")}`, [retained.path, retained.patchPath]);
		const updated: RetainedWorktree = {
			...retained,
			status: "done",
			error,
			kind: "cleanup-failed",
			retryable: false,
			rootIntegrated: true,
			patchBuffer: undefined,
		};
		this.retainedWorktrees.set(retained.taskId, updated);
		return this.retainedView(updated);
	}

	// User-driven discard/cleanup of a retained worktree. Caller confirmation is
	// the UI's responsibility. Never touches the repository root; it removes only
	// the exact internal registered worktree via `git worktree remove --force`,
	// prunes, and unlinks the temp patch with a bounded Windows retry. On
	// persistent failure the entry is retained and a redacted error returned.
	discardRetainedWorktree(taskId: string): RetainedWorktreeView {
		if (this.disposed) throw new Error("OpenCode task manager is shut down.");
		const retained = this.retainedWorktrees.get(taskId);
		if (!retained) throw new Error(`No retained worktree found for task ${taskId}.`);
		const block = this.sameRepoActivityBlock(retained.repoRoot);
		if (block) throw new Error(block);
		const remove = runGitResult(retained.repoRoot, ["worktree", "remove", "--force", retained.path]);
		runGitResult(retained.repoRoot, ["worktree", "prune"]);
		const patchCleanupError = this.removePatchFileWithRetry(retained.patchPath);
		if (remove.ok && !patchCleanupError) {
			this.retainedWorktrees.delete(taskId);
			return this.retainedView({ ...retained, error: undefined });
		}
		const failures: string[] = [];
		if (!remove.ok) {
			const stderr = redactAbsolutePaths(remove.stderr.toString("utf8").trim(), [retained.path, retained.patchPath]);
			failures.push(`git worktree remove failed: ${stderr || "unknown error"}`);
		}
		if (patchCleanupError) failures.push(patchCleanupError);
		const error = redactAbsolutePaths(`Cleanup failed: ${failures.join("; ")}`, [retained.path, retained.patchPath]);
		const updated: RetainedWorktree = { ...retained, error };
		this.retainedWorktrees.set(taskId, updated);
		return this.retainedView(updated);
	}

	async dispose() {
		this.disposed = true;
		const running = this.runningEntries();
		for (const entry of running) {
			entry.cancelRequested = true;
			if (entry.child) {
				const child = entry.child;
				killProcessTree(child, "SIGTERM");
				setTimeout(() => killProcessTree(child, "SIGKILL"), 5_000).unref();
			}
		}
		await Promise.all(running.map((entry) => this.waitOne(entry).catch(() => undefined)));
	}
}
