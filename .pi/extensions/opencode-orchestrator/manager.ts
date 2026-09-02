import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
	WorkerRole,
	WorktreeRetentionKind,
	WorktreeSnapshotInfo,
} from "./types.ts";
import {
	boundedAppend,
	buildAgentFrontmatter,
	buildWorkerPrompt,
	configuredModelCapabilities,
	configuredModelProfiles,
	configuredTesterProfile,
	configuredThinkingLevel,
	decodeWorkerModel,
	DEFAULT_MODEL,
	DEFAULT_TOOL_PROFILE,
	enforceToolLimit,
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
	resolveToolProfile,
	toolsForProfile,
	type ModelCapability,
	type ToolProfile,
} from "./types.ts";

function opencodeAgentDir(): string {
	// OpenCode resolves agents by name from ~/.config/opencode/agent/ on every platform.
	return path.join(os.homedir(), ".config", "opencode", "agent");
}

function writeAgentDefinition(taskId: string, profile: ToolProfile, mode: TaskMode): string {
	const frontmatter = buildAgentFrontmatter(profile, mode);
	const body = "You are a bounded worker delegated by a parent Pi orchestrator. Follow the repository's AGENTS.md. Do not read secrets or git-ignored runtime configuration. Stay within the declared scope and report missing scope instead of broadening the task.";
	const dir = opencodeAgentDir();
	mkdirSync(dir, { recursive: true });
	const name = `pi-orch-${taskId}-${randomBytes(4).toString("hex")}`;
	const file = path.join(dir, `${name}.md`);
	writeFileSync(file, `${frontmatter}
${body}
`, { encoding: "utf-8" });
	return name;
}

function cleanupAgentDefinition(name: string | undefined) {
	if (!name) return;
	const file = path.join(opencodeAgentDir(), `${name}.md`);
	try { unlinkSync(file); } catch { /* already removed or missing */ }
}

interface ManagedTask {
	snapshot: TaskSnapshot;
	child?: ChildProcess;
	buffer: string;
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
	patchPath: string;
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
	baseHead: string;
	expectedFingerprint: GitFingerprint;
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
	scopes: string[];
	changedPaths: string[];
	conflictPaths: string[];
	status: TaskSnapshot["status"];
	error?: string;
	createdAt: number;
	patchPath: string;
	patchBuffer?: Buffer;
	kind: WorktreeRetentionKind;
	retryable: boolean;
	rootIntegrated: boolean;
}

interface ManagerOptions {
	onChange?: () => void;
	binary?: string;
	binaryArgs?: string[];
	model?: string;
	timeoutMs?: number;
	piBinary?: string;
	piBinaryArgs?: string[];
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

function activityFromEvent(event: Record<string, unknown>) {
	const part = event.part && typeof event.part === "object"
		? event.part as Record<string, unknown>
		: undefined;
	const type = typeof event.type === "string" ? event.type : "event";
	if (!part) return type;
	if (part.type === "tool") {
		const tool = typeof part.tool === "string" ? part.tool : "tool";
		const state = part.state && typeof part.state === "object"
			? part.state as Record<string, unknown>
			: undefined;
		const status = state && typeof state.status === "string" ? state.status : "update";
		return `${tool}: ${status}`;
	}
	if (part.type === "step-finish") {
		return `step finished: ${typeof part.reason === "string" ? part.reason : "unknown"}`;
	}
	return `${type}: ${String(part.type ?? "unknown")}`;
}

// Exact Pi child tool lists. Existing unroled read/write behavior is preserved;
// tester additionally gets bash (but no edit/write), and reviewer is strictly
// read/grep/find/ls.
function piToolList(spec: Pick<TaskSpec, "mode" | "role">) {
	if (spec.role === "reviewer") return "read,grep,find,ls";
	if (spec.role === "tester") return "read,grep,find,ls,bash";
	return spec.mode === "read_only" ? "read,grep,find,ls" : "read,grep,find,ls,bash,edit,write";
}

interface RolePermissionOverride {
	edit: "deny";
	bash: "deny" | Record<string, "allow">;
}

// Official permission semantics: edit covers edit/write/patch, and the last
// matching bash rule wins. The forced bash override is therefore appended as the
// last rule so it wins for any matching command. Bash immutability is never claimed.
function rolePermissionOverride(role: WorkerRole | undefined): RolePermissionOverride | undefined {
	if (role === "tester") return { edit: "deny", bash: { "*": "allow" } };
	if (role === "reviewer") return { edit: "deny", bash: "deny" };
	return undefined;
}

/**
 * Merge a valid existing OPENCODE_CONFIG_CONTENT with the role-specific
 * permission override for the OpenCode child. Any existing top-level keys and
 * non-forced permission keys are preserved; an invalid existing value is
 * ignored in favor of the forced override. Returns undefined when no override
 * applies and nothing valid is present.
 */
export function buildOpenCodeConfigContent(
	role: WorkerRole | undefined,
	existingContent: string | undefined,
): string | undefined {
	const override = rolePermissionOverride(role);
	if (!override) return existingContent;
	let base: Record<string, unknown> = {};
	if (existingContent) {
		try {
			const parsed: unknown = JSON.parse(existingContent);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				base = parsed as Record<string, unknown>;
			}
		} catch {
			// Invalid existing inline config is ignored; the override still applies.
		}
	}
	const permission = base.permission && typeof base.permission === "object" && !Array.isArray(base.permission)
		? { ...(base.permission as Record<string, unknown>) }
		: {};
	permission.edit = override.edit;
	if (override.bash === "deny") {
		permission.bash = "deny";
	} else {
		const existingBash = permission.bash && typeof permission.bash === "object" && !Array.isArray(permission.bash)
			? { ...(permission.bash as Record<string, unknown>) }
			: {};
		// Remove any prior "*" rule and re-insert it last so the forced override
		// is the final matching bash rule.
		delete existingBash["*"];
		existingBash["*"] = override.bash["*"];
		permission.bash = existingBash;
	}
	return JSON.stringify({ ...base, permission });
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
function runGitResult(cwd: string, args: string[]) {
	try {
		const stdout = execFileSync("git", args, { cwd, encoding: "buffer", stdio: ["ignore", "pipe", "pipe"] });
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

// A fingerprint is clean when no tracked/staged diff and no nonignored
// untracked paths exist (paths are captured from porcelain status + untracked).
function isCleanFingerprint(fp: GitFingerprint) {
	return fp.paths.length === 0;
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
	const add = (value: string) => {
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
function redactAbsolutePaths(text: string, paths: string[]): string {
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

/**
 * Capture a content-based Git fingerprint of the working tree: tracked worktree
 * diff, staged diff, and nonignored untracked paths with their contents. Paths
 * are NUL-safe (git -z), gitignore-aware (--exclude-standard), and file
 * contents are hashed internally and never exposed. Only path names are kept
 * for the change diagnostic.
 */
function captureGitFingerprint(cwd: string): GitFingerprint | undefined {
	const worktreeCheck = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (!worktreeCheck || worktreeCheck.toString("utf8").trim() !== "true") return undefined;
	const hash = createHash("sha256");
	const paths = new Set<string>();

	hash.update(Buffer.from("worktree-diff\0"));
	hash.update(runGit(cwd, ["diff", "--no-color", "--binary"]) ?? Buffer.alloc(0));
	hash.update(Buffer.from("\0staged-diff\0"));
	hash.update(runGit(cwd, ["diff", "--cached", "--no-color", "--binary"]) ?? Buffer.alloc(0));
	hash.update(Buffer.from("\0untracked\0"));
	const untracked = runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
	if (untracked) {
		for (const relative of splitNul(untracked)) {
			paths.add(relative);
			hash.update(Buffer.from(relative, "utf8"));
			hash.update(Buffer.from("\0"));
			try {
				hash.update(readFileSync(path.join(cwd, relative)));
			} catch {
				hash.update(Buffer.from("<unreadable>"));
			}
			hash.update(Buffer.from("\0"));
		}
	}
	const status = runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
	const statusByPath = new Map<string, string>();
	if (status) {
		for (const entry of splitNul(status)) {
			// porcelain v1 -z entries are "<XY> path"; untracked entries are "?? path".
			if (entry.length > 3) {
				const relative = entry.slice(3);
				paths.add(relative);
				statusByPath.set(relative, entry.slice(0, 2));
			} else if (entry.length > 0) {
				paths.add(entry);
			}
		}
	}

	// Capture state for every currently dirty/untracked path. Besides the
	// working-tree bytes, include both index and worktree diffs so a dirty
	// baseline remains distinguishable when the worker changes the same path.
	const pathHashes = new Map<string, string>();
	for (const relative of paths) {
		const pathHash = createHash("sha256");
		pathHash.update(statusByPath.get(relative) ?? "");
		pathHash.update(Buffer.from("\\0worktree-content\\0"));
		try {
			const file = path.join(cwd, relative);
			const stats = statSync(file);
			pathHash.update(Buffer.from(`${stats.mode}:${stats.size}:`));
			pathHash.update(readFileSync(file));
		} catch {
			pathHash.update(Buffer.from("<missing-or-unreadable>"));
		}
		pathHash.update(Buffer.from("\\0unstaged-diff\\0"));
		pathHash.update(runGit(cwd, ["diff", "--no-color", "--binary", "--full-index", "--", relative]) ?? Buffer.alloc(0));
		pathHash.update(Buffer.from("\\0staged-diff\\0"));
		pathHash.update(runGit(cwd, ["diff", "--cached", "--no-color", "--binary", "--full-index", "--", relative]) ?? Buffer.alloc(0));
		pathHashes.set(relative, pathHash.digest("hex"));
	}
	return { hash: hash.digest("hex"), paths: [...paths].sort(), pathHashes };
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
		mutated: after.hash !== baseline.hash || changedPaths.length > 0,
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
	private thinkingLevel: ThinkingLevel;
	private readonly modelCapabilities: Record<string, ModelCapability>;
	private readonly defaultToolProfile: ToolProfile;
	private readonly worktreeBatches = new Map<string, WorktreeBatch>();
	private readonly retainedWorktrees = new Map<string, RetainedWorktree>();

	constructor(options: ManagerOptions = {}) {
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
	}

	configuration() {
		return {
			binary: this.binary,
			piBinary: this.piBinary,
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
			return "Concurrent write tasks require every currently running write task (and this one) to opt into worktree isolation (worktree=true).";
		}
		return undefined;
	}

	private spawnBlockReason(spec: InternalTaskSpec, cwd: string) {
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
		const blockReason = this.spawnBlockReason(spec, cwd);
		if (blockReason) throw new Error(blockReason);
		if ((spec.role === "tester" || spec.role === "reviewer") && spec.mode !== "read_only") {
			throw new Error(`Role ${spec.role} requires mode read_only.`);
		}
		if (spec.worktree && spec.mode !== "write") {
			throw new Error("Worktree isolation (worktree=true) requires mode write.");
		}
		const scopes = normalizeScopes(cwd, spec.relevantPaths);
		const id = `oc-${++this.counter}`;
		const selection = decodeWorkerModel(resolveModel(spec, this.defaultModel, this.modelProfiles, this.testerModel));
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
			settleListeners: new Set(),
			waiters: 0,
			consumed: false,
			delivered: false,
			cancelRequested: false,
		};
		let childCwd = cwd;
		if (spec.worktree) {
			childCwd = this.prepareWorktree(entry, cwd, scopes);
		}
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
	}

	async spawnWhenAvailable(spec: InternalTaskSpec, cwd: string, signal?: AbortSignal) {
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

	private start(entry: ManagedTask, spec: TaskSpec, cwd: string) {
		const prompt = buildWorkerPrompt(spec);
		const isPiWorker = entry.snapshot.backend === "pi";
		const thinking = resolveThinkingLevel(spec, this.thinkingLevel);
		const binary = isPiWorker ? this.piBinary : this.binary;
		// Tool capability routing: OpenCode workers get a generated agent definition so
		// the parent owns the tool set, instead of inheriting ambient OpenCode config.
		// Pi workers already pass --tools explicitly.
		let agentName: string | undefined;
		let capabilityNotice: string | undefined;
		if (!isPiWorker) {
			const profile = resolveToolProfile(spec, this.defaultToolProfile);
			const capability = this.modelCapabilities[entry.snapshot.model];
			const tools = enforceToolLimit(toolsForProfile(profile, spec.mode), capability);
			if (tools.reduced) capabilityNotice = tools.reason;
			agentName = writeAgentDefinition(entry.snapshot.id, profile, spec.mode);
			entry.snapshot.activity.push(`agent profile: ${profile} (${tools.tools.join(",")})`);
			if (capabilityNotice) entry.snapshot.activity.push(`capability: ${capabilityNotice}`);
			if (entry.snapshot.activity.length > MAX_ACTIVITY_ITEMS) entry.snapshot.activity.shift();
		}
		const args = isPiWorker
			? [
				...this.piBinaryArgs,
				"--approve",
				"--no-session",
				"--no-extensions",
				"--mode",
				"json",
				"--model",
				entry.snapshot.model,
				"--thinking",
				thinking,
				"--tools",
				piToolList(spec),
				prompt,
			]
			: [
				...this.binaryArgs,
				"run",
				"--format",
				"json",
				"--model",
				entry.snapshot.model,
				"--variant",
				thinking,
				...(agentName ? ["--agent", agentName] : []),
				prompt,
			];
		// OpenCode children inherit the environment; role workers additionally get
		// a forced official permission override merged over any valid inline config.
		const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
		const mergedConfig = buildOpenCodeConfigContent(spec.role, env.OPENCODE_CONFIG_CONTENT);
		if (mergedConfig !== undefined) env.OPENCODE_CONFIG_CONTENT = mergedConfig;
		const child = spawn(binary, args, {
			cwd,
			env,
			detached: os.platform() !== "win32",
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		entry.child = child;

		const timeout = setTimeout(() => {
			entry.snapshot.timedOut = true;
			entry.snapshot.error = `${isPiWorker ? "Pi" : "OpenCode"} worker timed out after ${this.timeoutMs} ms.`;
			killProcessTree(child, "SIGTERM");
			setTimeout(() => { killProcessTree(child, "SIGKILL"); cleanupAgentDefinition(agentName); }, 5_000).unref();
		}, this.timeoutMs);
		timeout.unref();

		child.stdout?.on("data", (data: Buffer) => this.consumeStdout(entry, data.toString("utf8")));
		child.stderr?.on("data", (data: Buffer) => {
			const appended = boundedAppend(entry.snapshot.stderr, data.toString("utf8"));
			entry.snapshot.stderr = appended.text;
			entry.snapshot.truncated ||= appended.truncated;
			this.notify();
		});
		child.on("error", (error) => {
			entry.snapshot.error = `Failed to start ${isPiWorker ? "Pi" : "OpenCode"} worker: ${processError(error)}`;
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			cleanupAgentDefinition(agentName);
			if (entry.buffer.trim()) this.consumeLine(entry, entry.buffer);
			entry.buffer = "";
			entry.snapshot.exitCode = code ?? 1;
			entry.snapshot.report = parseWorkerReport(entry.snapshot.output);
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
					this.resolveStatus(entry, code, isPiWorker);
					this.redactWorktreeDiagnostics(entry);
					const code_: RetentionCode = entry.cancelRequested
						? "cancel"
						: entry.snapshot.timedOut
							? "timeout"
							: "worker-failure";
					this.markWorktreeRetained(
						entry,
						code_,
						entry.snapshot.error ?? `${isPiWorker ? "Pi" : "OpenCode"} worker did not exit cleanly.`,
					);
					this.finishSettle(entry);
				} else {
					void this.finalizeWorktree(entry).then(
						() => {
							this.resolveStatus(entry, code, isPiWorker);
							this.redactWorktreeDiagnostics(entry);
							this.finishSettle(entry);
						},
						(error: unknown) => {
							entry.snapshot.error = processError(error);
							entry.snapshot.status = "error";
							this.redactWorktreeDiagnostics(entry);
							this.markWorktreeRetained(entry, retentionCodeOf(error), entry.snapshot.error);
							this.finishSettle(entry);
						},
					);
				}
				return;
			}
			this.resolveStatus(entry, code, isPiWorker);
			this.finishSettle(entry);
		});
	}

	private resolveStatus(entry: ManagedTask, code: number | null, isPiWorker: boolean) {
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
			entry.snapshot.error ??= `${isPiWorker ? "Pi" : "OpenCode"} worker exited with code ${code ?? 1}.`;
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
				tasks: [],
				poisoned: false,
				open: true,
			};
			this.worktreeBatches.set(key, batch);
		}
		mkdirSync(baseDir, { recursive: true });
		const wtPath = path.join(baseDir, entry.snapshot.id);
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
		mkdirSync(childCwd, { recursive: true });
		entry.worktree = {
			path: wtPath,
			repoRoot,
			childCwd,
			baseHead: batch.baseHead,
			scopes,
			batch,
			patchPath: path.join(baseDir, `${entry.snapshot.id}.patch`),
		};
		entry.snapshot.worktree = { isolated: true, baseHead: batch.baseHead, status: "pending" };
		batch.tasks.push(entry);
		return childCwd;
	}

	// Validate the isolated changes and enqueue integration through the
	// per-repo ID-ordered batch queue. Any rejection retains the worktree.
	private async finalizeWorktree(entry: ManagedTask): Promise<void> {
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
		this.applyPatch(entry);
	}

	// Apply at the repository root without staging/root reset/stash: fingerprint
	// guard, `git apply --check`, then `git apply`. Update the batch's expected
	// fingerprint and remove/prune the successfully integrated worktree.
	private applyPatch(entry: ManagedTask): void {
		const wt = entry.worktree!;
		const batch = wt.batch;
		if (batch.poisoned) {
			throw new RetentionError("integration-conflict", "Batch integration aborted after an external root mutation; refusing to apply.");
		}
		const fp = captureGitFingerprint(wt.repoRoot);
		if (!fp) throw new Error("Unable to capture the repository root fingerprint before integration.");
		if (fp.hash !== batch.expectedFingerprint.hash) {
			batch.poisoned = true;
			throw new RetentionError("integration-conflict", "External mutation detected at the repository root; integration aborted for this batch and its remaining tasks.");
		}
		const patch = wt.patchBuffer ?? Buffer.alloc(0);
		if (patch.length > 0) {
			writeFileSync(wt.patchPath, patch);
			const check = runGitResult(wt.repoRoot, ["apply", "--check", wt.patchPath]);
			if (!check.ok) {
				throw new RetentionError("integration-conflict", `git apply --check rejected the isolated patch: ${check.stderr.toString("utf8").trim() || "patch does not apply cleanly"}`);
			}
			const apply = runGitResult(wt.repoRoot, ["apply", wt.patchPath]);
			if (!apply.ok) {
				throw new RetentionError("integration-conflict", `git apply failed: ${apply.stderr.toString("utf8").trim() || "apply error"}`);
			}
			const after = captureGitFingerprint(wt.repoRoot);
			if (after) batch.expectedFingerprint = after;
		}
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
	private removePatchFile(patchPath: string): string | undefined {
		try {
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
	private removePatchFileWithRetry(patchPath: string): string | undefined {
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

	// Validate and (re)create the parent directory of a temporary patch file
	// before it is written by retry. The parent must be contained within a known
	// WorktreeRuntime temp root (the repo-hash OS-temp directory that this
	// manager created), decided with path.relative containment -- a caller
	// supplied path is never accepted. On any failure a redacted, clear error is
	// thrown so the retry cannot write to an unexpected or unavailable location.
	private ensureRetryPatchParent(patchPath: string, repoRoot: string): void {
		const parent = path.dirname(patchPath);
		const root = worktreeRootDir(repoRoot);
		const rel = path.relative(root, parent);
		const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
		if (!inside) {
			throw new Error(
				"Retry aborted: the temporary patch location is not within the managed worktree temp root; refusing to write outside the internally-derived directory.",
			);
		}
		try {
			mkdirSync(parent, { recursive: true });
		} catch (error) {
			throw new Error(`Retry aborted: unable to create the temporary patch directory: ${processError(error)}`);
		}
		if (!this.isDirectoryAvailable(parent)) {
			throw new Error("Retry aborted: the temporary patch directory is not writable; refusing to write the retry patch.");
		}
	}

	private isDirectoryAvailable(dir: string): boolean {
		try {
			return statSync(dir).isDirectory();
		} catch {
			return false;
		}
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
			scopes: wt.scopes.map((scope) => this.repoRelative(wt.repoRoot, scope)),
			changedPaths: [...(wt.changedPaths ?? [])],
			conflictPaths: [...(wt.conflictPaths ?? [])],
			status: entry.snapshot.status,
			error: reason,
			createdAt: entry.snapshot.createdAt,
			patchPath: wt.patchPath,
			patchBuffer: wt.patchBuffer,
			kind,
			retryable: kind === "integration-failure",
			rootIntegrated: false,
		});
	}

	// Convert an absolute path to a POSIX-separated repo-relative path for the
	// public view, falling back to the input when it escapes the repository.
	private repoRelative(repoRoot: string, abs: string): string {
		const rel = path.relative(repoRoot, abs);
		if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return abs;
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

	private consumeLine(entry: ManagedTask, line: string) {
		if (!line.trim()) return;
		let event: Record<string, unknown> | undefined;
		try {
			const parsed: unknown = JSON.parse(line);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) event = parsed as Record<string, unknown>;
		} catch {
			// OpenCode may emit a plain diagnostic line before JSON events.
		}
		if (!event) {
			const appended = boundedAppend(entry.snapshot.output, `${line}\n`);
			entry.snapshot.output = appended.text;
			entry.snapshot.truncated ||= appended.truncated;
			if (entry.snapshot.backend === "pi") {
				entry.snapshot.activity.push("Pi response streaming");
				if (entry.snapshot.activity.length > MAX_ACTIVITY_ITEMS) entry.snapshot.activity.shift();
			}
			return;
		}
		const part = event.part && typeof event.part === "object"
			? event.part as Record<string, unknown>
			: undefined;
		// OpenCode text streaming remains the primary output path for OpenCode workers.
		if (event.type === "text" && part && typeof part.text === "string") {
			const appended = boundedAppend(entry.snapshot.output, `${part.text}\n`);
			entry.snapshot.output = appended.text;
			entry.snapshot.truncated ||= appended.truncated;
		}
		// Pi JSON mode: append assistant text content at message_end (not message_update,
		// to avoid double-counting streaming deltas). Usage is captured separately below.
		if (event.type === "message_end") {
			const message = event.message && typeof event.message === "object"
				? event.message as Record<string, unknown>
				: undefined;
			const content = message?.content;
			if (Array.isArray(content)) {
				for (const item of content) {
					if (item && typeof item === "object") {
						const node = item as Record<string, unknown>;
						if (node.type === "text" && typeof node.text === "string") {
							const appended = boundedAppend(entry.snapshot.output, `${node.text}\n`);
							entry.snapshot.output = appended.text;
							entry.snapshot.truncated ||= appended.truncated;
						}
					}
				}
			}
		}
		const usage = extractUsageFromEvent(event);
		if (usage) {
			entry.snapshot.usage = mergeUsage(entry.snapshot.usage, usage);
		}
		entry.snapshot.activity.push(activityFromEvent(event));
		if (entry.snapshot.activity.length > MAX_ACTIVITY_ITEMS) entry.snapshot.activity.shift();
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
			if (entry.snapshot.status !== "running" || !entry.child) continue;
			entry.cancelRequested = true;
			killProcessTree(entry.child, "SIGTERM");
			setTimeout(() => entry.child && killProcessTree(entry.child, "SIGKILL"), 5_000).unref();
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
	// not integrated are eligible. The fingerprint guard + `git apply --check` +
	// apply are performed synchronously with no await between the final
	// fingerprint capture and the apply, so the root cannot change under us.
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

		// Synchronous fingerprint guard: capture, apply --check, re-capture and
		// require the fingerprint is unchanged, then apply. No 3way/reset/stash/
		// commit/overwrite and no await between the final fingerprint and apply.
		const before = captureGitFingerprint(retained.repoRoot);
		if (!before) {
			throw new Error("Unable to capture the repository root fingerprint before retry.");
		}
		this.ensureRetryPatchParent(retained.patchPath, retained.repoRoot);
		writeFileSync(retained.patchPath, retained.patchBuffer);
		const check = runGitResult(retained.repoRoot, ["apply", "--check", retained.patchPath]);
		if (!check.ok) {
			throw new Error(
				`Retry rejected: the patch no longer applies; git apply --check reported: ${redactAbsolutePaths(check.stderr.toString("utf8").trim(), [retained.path, retained.patchPath]) || "patch does not apply cleanly"}`,
			);
		}
		const after = captureGitFingerprint(retained.repoRoot);
		if (!after || after.hash !== before.hash) {
			throw new Error("Repository fingerprint changed between pre-check and apply; retry aborted without applying.");
		}
		const apply = runGitResult(retained.repoRoot, ["apply", retained.patchPath]);
		if (!apply.ok) {
			throw new Error(
				`Retry git apply failed: ${redactAbsolutePaths(apply.stderr.toString("utf8").trim(), [retained.path, retained.patchPath]) || "apply error"}`,
			);
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
