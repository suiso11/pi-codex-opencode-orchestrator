import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import { activityFromEvent, type BackendSpawnInput, type WorkerBackendAdapter } from "./backends/backend.ts";
import {
	agentFrontmatterFromTools,
	buildOpenCodeConfigContent,
	effectiveWorkerTools,
	executorGateError,
	OpenCodeBackendAdapter,
} from "./backends/opencode.ts";
import { CollieBackendAdapter, collieGateError } from "./backends/collie.ts";
import { PiBackendAdapter, piToolList } from "./backends/pi.ts";
import { TOOL_PROFILES } from "./types.ts";
import type { TaskSpec, WorkerReport } from "./types.ts";
import { buildWorkerEnv } from "./worker-env.ts";

function spawnInput(overrides: Partial<BackendSpawnInput> = {}): BackendSpawnInput {
	return {
		taskId: "oc-1",
		spec: {
			name: "unit",
			mode: "write",
			objective: "objective",
			relevantPaths: ["src"],
			constraints: [],
			expectedOutput: "",
		} satisfies TaskSpec,
		model: "opencode-go/glm-5.2",
		thinking: "high",
		prompt: "PROMPT",
		cwd: "/tmp/worktree",
		...overrides,
	};
}

function openCodeAdapter() {
	return new OpenCodeBackendAdapter({
		binary: "opencode",
		binaryArgs: [],
		defaultToolProfile: "coding",
		modelCapabilities: {},
	});
}

function agentDefinitionText(preparation: { agentName?: string; configDir?: string }): string {
	assert.ok(preparation.agentName);
	assert.ok(preparation.configDir);
	return readFileSync(path.join(preparation.configDir, "agent", `${preparation.agentName}.md`), "utf8");
}

test("OpenCodeBackendAdapter builds isolated --pure run args", () => {
	const adapter = new OpenCodeBackendAdapter({
		binary: "opencode",
		binaryArgs: ["--flag"],
		defaultToolProfile: "coding",
		modelCapabilities: {},
	});
	const input = spawnInput();
	assert.deepEqual(adapter.buildArgs(input, { agentName: "agent-x", activity: [] }), [
		"--flag", "run", "--pure", "--format", "json", "--model", input.model,
		"--variant", "high", "--agent", "agent-x", "PROMPT",
	]);
	assert.ok(!adapter.buildArgs(input, { activity: [] }).includes("--agent"));
});

test("OpenCode buildEnv discards ambient inline config and uses private config homes", () => {
	const adapter = openCodeAdapter();
	const input = spawnInput({ spec: { ...spawnInput().spec, role: "tester" } });
	const preparation = adapter.prepare(input);
	const base = {
		OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: "dark", mcp: { ambient: {} } }),
		XDG_DATA_HOME: "/private/data",
		CUSTOM: "1",
	};
	try {
		const env = adapter.buildEnv(base, input, preparation);
		assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT!), {
			permission: { edit: "deny", bash: { "*": "allow" } },
		});
		assert.equal(env.OPENCODE_CONFIG_DIR, preparation.configDir);
		assert.equal(env.XDG_CONFIG_HOME, preparation.runtimeDir);
		assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
		assert.equal(env.XDG_DATA_HOME, "/private/data");
		assert.equal(env.CUSTOM, "1");
		assert.equal(base.OPENCODE_CONFIG_CONTENT, JSON.stringify({ theme: "dark", mcp: { ambient: {} } }));
	} finally {
		adapter.cleanupAgent(preparation.agentName, preparation);
	}
});

test("OpenCode buildEnv removes ambient config entirely for an unroled worker", () => {
	const adapter = openCodeAdapter();
	const input = spawnInput();
	const preparation = adapter.prepare(input);
	try {
		const env = adapter.buildEnv({ OPENCODE_CONFIG_CONTENT: "not-json", XDG_CONFIG_HOME: "/ambient" }, input, preparation);
		assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined);
		assert.equal(env.XDG_CONFIG_HOME, preparation.runtimeDir);
		assert.equal(env.OPENCODE_CONFIG_DIR, preparation.configDir);
		assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
	} finally {
		adapter.cleanupAgent(preparation.agentName, preparation);
	}
});

test("OpenCode private agent definitions are scoped to the spawn and recursively cleaned", () => {
	const adapter = openCodeAdapter();
	const preparation = adapter.prepare(spawnInput());
	assert.ok(preparation.runtimeDir);
	assert.ok(preparation.configDir);
	assert.ok(preparation.configDir.startsWith(os.tmpdir()));
	assert.ok(!preparation.configDir.includes(path.join(os.homedir(), ".config")));
	assert.match(agentDefinitionText(preparation), /\*": deny/);
	const runtimeDir = preparation.runtimeDir;
	assert.equal(adapter.cleanupAgent(preparation.agentName, preparation), undefined);
	assert.equal(existsSync(runtimeDir), false);
	assert.doesNotThrow(() => adapter.cleanupAgent(undefined));
});

test("agent permissions are fail-closed and Executor is explicit", () => {
	const regular = agentFrontmatterFromTools(["read", "glob"]);
	assert.ok(regular.includes('permission:\n  "*": deny\n  read: allow\n  glob: allow'));
	assert.doesNotMatch(regular, /mcp\.executor/);
	assert.match(agentFrontmatterFromTools(TOOL_PROFILES.full), /skill: allow/);
	assert.ok(agentFrontmatterFromTools(["read"], true).includes('"mcp.executor.*": allow'));
	const config = JSON.parse(buildOpenCodeConfigContent("implementer", true, { PI_EXECUTOR_BIN: "custom-executor" })!);
	assert.deepEqual(config, {
		mcp: { executor: { type: "local", command: ["custom-executor", "mcp", "--elicitation-mode", "browser", "--no-artifacts", "--search-tools"] } },
	});
	assert.equal(buildOpenCodeConfigContent(undefined), undefined);
});

test("ambient config is never merged, including invalid JSON", () => {
	assert.deepEqual(JSON.parse(buildOpenCodeConfigContent("reviewer", false, { OPENCODE_CONFIG_CONTENT: "bad" })!), {
		permission: { edit: "deny", bash: "deny" },
	});
	assert.deepEqual(JSON.parse(buildOpenCodeConfigContent("tester", false, { OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: "dark" }) })!), {
		permission: { edit: "deny", bash: { "*": "allow" } },
	});
	assert.equal(buildOpenCodeConfigContent("implementer", false), undefined);
});

test("Executor gate is opt-in and fail-closed for non-implementer routes", () => {
	const input = { spec: { ...spawnInput().spec, executor: true, role: "implementer" as const }, model: "opencode-go/model" };
	assert.match(executorGateError(input, {}) ?? "", /PI_ORCH_ENABLE_EXECUTOR/);
	assert.match(executorGateError({ ...input, spec: { ...input.spec, role: undefined } }, { PI_ORCH_ENABLE_EXECUTOR: "1" }) ?? "", /explicit implementer/);
	assert.match(executorGateError({ ...input, model: "pi::provider/model" }, { PI_ORCH_ENABLE_EXECUTOR: "1" }) ?? "", /OpenCode backend/);
	assert.equal(executorGateError(input, { PI_ORCH_ENABLE_EXECUTOR: "1" }), undefined);
});

test("effective OpenCode tools preserve tester bash and deny excluded tools", () => {
	assert.deepEqual([...effectiveWorkerTools({ mode: "read_only", role: "tester" }, "coding")], ["bash", "read", "glob", "grep"]);
	assert.deepEqual([...effectiveWorkerTools({ mode: "write", role: "tester" }, "coding")], ["read", "glob", "grep", "edit", "bash"]);
	assert.deepEqual([...effectiveWorkerTools({ mode: "read_only", role: "reviewer" }, "coding")], ["read", "glob", "grep"]);
	const adapter = openCodeAdapter();
	const preparation = adapter.prepare(spawnInput({ spec: { ...spawnInput().spec, mode: "read_only", role: "tester" } }));
	try {
		const text = agentDefinitionText(preparation);
		assert.match(text, /bash: allow/);
		assert.doesNotMatch(text, /edit: allow/);
	} finally { adapter.cleanupAgent(preparation.agentName, preparation); }
});

test("Pi and Collie retain explicit backend boundaries", () => {
	const pi = new PiBackendAdapter({ binary: "pi", binaryArgs: ["--ext"] });
	const piInput = spawnInput({ model: "anthropic/claude", spec: { ...spawnInput().spec, mode: "read_only", role: "tester" } });
	assert.deepEqual(pi.buildArgs(piInput, { activity: [] }), ["--ext", "--approve", "--no-session", "--no-extensions", "--mode", "json", "--model", "anthropic/claude", "--thinking", "high", "--tools", "read,grep,find,ls,bash", "PROMPT"]);
	assert.equal(piToolList({ mode: "read_only", role: "reviewer" }), "read,grep,find,ls");
	assert.equal(piToolList({ mode: "write", role: undefined }), "read,grep,find,ls,bash,edit,write");
	const collie = new CollieBackendAdapter({ binary: "collie", binaryArgs: ["--wrapper"] });
	const collieInput = spawnInput({ model: "provider/model-name", spec: { ...spawnInput().spec, mode: "write", role: "implementer", worktree: true } });
	assert.deepEqual(collie.buildArgs(collieInput, { activity: [] }), ["--wrapper", "run", "PROMPT", "--provider", "provider", "--model", "model-name", "--cwd", "/tmp/worktree", "--mode", "auto", "--json", "--stream-json"]);
	assert.match(collieGateError({ spec: { ...collieInput.spec, mode: "read_only" } }, { PI_ORCH_ENABLE_COLLIE: "1" }) ?? "", /mode=write/);
	assert.match(collieGateError({ spec: collieInput.spec }, {}) ?? "", /disabled/);
});

test("shared output protocol helpers remain stable", () => {
	assert.equal(activityFromEvent({ type: "e", part: { type: "tool", tool: "read", state: { status: "completed" } } }), "read: completed");
	assert.equal(activityFromEvent({ type: "e", part: { type: "step-finish", reason: "stop" } }), "step finished: stop");
	assert.deepEqual(openCodeAdapter().decodeStdoutLine("plain", undefined), { output: "plain\n", activity: [] });
	const report: WorkerReport = { summary: "s", files: [], findings: [], unresolved: [] };
	const adapters: WorkerBackendAdapter[] = [openCodeAdapter(), new PiBackendAdapter({ binary: "pi", binaryArgs: [] })];
	for (const adapter of adapters) {
		assert.deepEqual(adapter.decodeStderrChunk("raw\n"), { text: "raw\n", activity: [] });
		assert.deepEqual(adapter.normalizeExitReport(report), report);
	}
});

// Worker GitHub-auth preservation: buildWorkerEnv -> adapter.buildEnv feeds a
// real local `gh auth token` read from owned synthetic hosts.yml fixtures.
// Fixture tokens are distinct FAKE values; stdout is compared with a boolean
// assert.ok so a resolver regression that reads the parent real store can
// never leak a secret through a failure message. Buffers are cleared in
// finally. No network, no GH_TOKEN family, no real configs are touched.
function writeGhHostsFixture(dir: string, fakeToken: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		path.join(dir, "hosts.yml"),
		`github.com:\n    user: fixture-user\n    oauth_token: ${fakeToken}\n    git_protocol: https\n`,
		{ encoding: "utf-8" },
	);
}

function localGhAvailable(): boolean {
	try {
		return spawnSync("gh", ["--version"], { timeout: 10_000 }).status === 0;
	} catch {
		return false;
	}
}

function ghChildEnv(built: NodeJS.ProcessEnv, ownedHome: string): NodeJS.ProcessEnv {
	const child: NodeJS.ProcessEnv = {};
	if (process.env.PATH !== undefined) child.PATH = process.env.PATH;
	for (const name of ["SystemRoot", "PATHEXT", "COMSPEC", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"] as const) {
		if (process.env[name] !== undefined) child[name] = process.env[name];
	}
	child.HOME = ownedHome;
	child.USERPROFILE = ownedHome;
	if (built.GH_CONFIG_DIR !== undefined) child.GH_CONFIG_DIR = built.GH_CONFIG_DIR;
	if (built.XDG_CONFIG_HOME !== undefined) child.XDG_CONFIG_HOME = built.XDG_CONFIG_HOME;
	child.GH_NO_UPDATE_NOTIFIER = "1";
	child.GH_NO_EXTENSION_UPDATE_NOTIFIER = "1";
	child.GH_PROMPT_DISABLED = "1";
	child.GH_TELEMETRY = "0";
	return child;
}

function readGhTokenSync(childEnv: NodeJS.ProcessEnv): { status: number | null; stdout: Buffer; stderr: Buffer } {
	const result = spawnSync("gh", ["auth", "token"], { env: childEnv, timeout: 15_000 });
	return {
		status: result.status,
		stdout: Buffer.from(result.stdout ?? Buffer.alloc(0)),
		stderr: Buffer.from(result.stderr ?? Buffer.alloc(0)),
	};
}

test("worker gh auth keeps explicit GH_CONFIG_DIR while XDG stays private", () => {
	if (!localGhAvailable()) return;
	const root = mkdtempSync(path.join(os.tmpdir(), "gh-auth-explicit-"));
	let capturedOut: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	let capturedErr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	const adapter = openCodeAdapter();
	const preparation = adapter.prepare(spawnInput());
	try {
		const explicitDir = path.join(root, "explicit");
		const xdgRoot = path.join(root, "xdg");
		const homeDir = path.join(root, "home");
		const appDataRoot = path.join(root, "appdata");
		writeGhHostsFixture(explicitDir, "FAKE-GH-EXPLICIT-8f2c1a");
		writeGhHostsFixture(path.join(xdgRoot, "gh"), "FAKE-GH-XDG-4d9b2e");
		writeGhHostsFixture(path.join(homeDir, ".config", "gh"), "FAKE-GH-HOME-1c7f5a");
		writeGhHostsFixture(path.join(appDataRoot, "GitHub CLI"), "FAKE-GH-APPDATA-6e3b9d");
		const workerEnv = buildWorkerEnv({
			PATH: process.env.PATH ?? "",
			HOME: homeDir,
			USERPROFILE: homeDir,
			XDG_CONFIG_HOME: xdgRoot,
			GH_CONFIG_DIR: explicitDir,
			AppData: appDataRoot,
		});
		const built = adapter.buildEnv(workerEnv, spawnInput(), preparation);
		assert.equal(built.GH_CONFIG_DIR, explicitDir);
		assert.equal(built.XDG_CONFIG_HOME, preparation.runtimeDir);
		assert.ok(built.XDG_CONFIG_HOME !== xdgRoot);
		const probed = readGhTokenSync(ghChildEnv(built, homeDir));
		capturedOut = probed.stdout;
		capturedErr = probed.stderr;
		assert.equal(probed.status, 0);
		assert.ok(capturedOut.toString("utf8").trim() === "FAKE-GH-EXPLICIT-8f2c1a");
	} finally {
		capturedOut.fill(0);
		capturedErr.fill(0);
		adapter.cleanupAgent(preparation.agentName, preparation);
		rmSync(root, { recursive: true, force: true });
	}
});

test("worker gh auth prefers XDG_CONFIG_HOME/gh over home and AppData stores", () => {
	if (!localGhAvailable()) return;
	const root = mkdtempSync(path.join(os.tmpdir(), "gh-auth-xdg-"));
	let capturedOut: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	let capturedErr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	const adapter = openCodeAdapter();
	const preparation = adapter.prepare(spawnInput());
	try {
		const xdgRoot = path.join(root, "xdg");
		const homeDir = path.join(root, "home");
		const appDataRoot = path.join(root, "appdata");
		writeGhHostsFixture(path.join(xdgRoot, "gh"), "FAKE-GH-XDG-9a4e2c");
		writeGhHostsFixture(path.join(homeDir, ".config", "gh"), "FAKE-GH-HOME-3b8d1f");
		writeGhHostsFixture(path.join(appDataRoot, "GitHub CLI"), "FAKE-GH-APPDATA-5c1a7e");
		const workerEnv = buildWorkerEnv({
			PATH: process.env.PATH ?? "",
			HOME: homeDir,
			USERPROFILE: homeDir,
			XDG_CONFIG_HOME: xdgRoot,
			AppData: appDataRoot,
		});
		const built = adapter.buildEnv(workerEnv, spawnInput(), preparation);
		assert.equal(built.GH_CONFIG_DIR, path.join(xdgRoot, "gh"));
		assert.equal(built.XDG_CONFIG_HOME, preparation.runtimeDir);
		const probed = readGhTokenSync(ghChildEnv(built, homeDir));
		capturedOut = probed.stdout;
		capturedErr = probed.stderr;
		assert.equal(probed.status, 0);
		assert.ok(capturedOut.toString("utf8").trim() === "FAKE-GH-XDG-9a4e2c");
	} finally {
		capturedOut.fill(0);
		capturedErr.fill(0);
		adapter.cleanupAgent(preparation.agentName, preparation);
		rmSync(root, { recursive: true, force: true });
	}
});

test("worker gh auth falls back to HOME/.config/gh", () => {
	if (!localGhAvailable()) return;
	const root = mkdtempSync(path.join(os.tmpdir(), "gh-auth-home-"));
	let capturedOut: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	let capturedErr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	const adapter = openCodeAdapter();
	const preparation = adapter.prepare(spawnInput());
	try {
		const homeDir = path.join(root, "home");
		writeGhHostsFixture(path.join(homeDir, ".config", "gh"), "FAKE-GH-HOME-2e6b4a");
		const workerEnv = buildWorkerEnv({
			PATH: process.env.PATH ?? "",
			HOME: homeDir,
			USERPROFILE: homeDir,
		});
		const built = adapter.buildEnv(workerEnv, spawnInput(), preparation);
		assert.equal(built.GH_CONFIG_DIR, path.join(homeDir, ".config", "gh"));
		assert.equal(built.XDG_CONFIG_HOME, preparation.runtimeDir);
		const probed = readGhTokenSync(ghChildEnv(built, homeDir));
		capturedOut = probed.stdout;
		capturedErr = probed.stderr;
		assert.equal(probed.status, 0);
		assert.ok(capturedOut.toString("utf8").trim() === "FAKE-GH-HOME-2e6b4a");
	} finally {
		capturedOut.fill(0);
		capturedErr.fill(0);
		adapter.cleanupAgent(preparation.agentName, preparation);
		rmSync(root, { recursive: true, force: true });
	}
});

test("worker gh auth home fallback follows the native platform store", () => {
	if (!localGhAvailable()) return;
	const root = mkdtempSync(path.join(os.tmpdir(), "gh-auth-home-select-"));
	let capturedOut: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	let capturedErr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	const adapter = openCodeAdapter();
	const preparation = adapter.prepare(spawnInput());
	try {
		const homeDir = path.join(root, "home");
		const profileDir = path.join(root, "profile");
		writeGhHostsFixture(path.join(homeDir, ".config", "gh"), "FAKE-GH-HOME-DISTINCT-a1b2c3");
		writeGhHostsFixture(path.join(profileDir, ".config", "gh"), "FAKE-GH-PROFILE-DISTINCT-d4e5f6");
		// No GH_CONFIG_DIR/XDG_CONFIG_HOME/AppData selectors: the home
		// fallback alone must pick the native platform store. Native gh
		// (go-gh v2.12.2 ConfigDir via Go os.UserHomeDir) uses %USERPROFILE%
		// on Windows and $HOME on POSIX; a generic HOME-first fallback
		// points at the wrong account store on Windows when they differ.
		const workerEnv = buildWorkerEnv({
			PATH: process.env.PATH ?? "",
			HOME: homeDir,
			USERPROFILE: profileDir,
		});
		const built = adapter.buildEnv(workerEnv, spawnInput(), preparation);
		const onWindows = process.platform === "win32";
		const expectedDir = onWindows ? profileDir : homeDir;
		const expectedToken = onWindows ? "FAKE-GH-PROFILE-DISTINCT-d4e5f6" : "FAKE-GH-HOME-DISTINCT-a1b2c3";
		assert.equal(built.GH_CONFIG_DIR, path.join(expectedDir, ".config", "gh"));
		assert.equal(built.XDG_CONFIG_HOME, preparation.runtimeDir);
		const child = ghChildEnv(built, homeDir);
		child.HOME = homeDir;
		child.USERPROFILE = profileDir;
		const probed = readGhTokenSync(child);
		capturedOut = probed.stdout;
		capturedErr = probed.stderr;
		assert.equal(probed.status, 0);
		assert.ok(capturedOut.toString("utf8").trim() === expectedToken);
	} finally {
		capturedOut.fill(0);
		capturedErr.fill(0);
		adapter.cleanupAgent(preparation.agentName, preparation);
		rmSync(root, { recursive: true, force: true });
	}
});

if (process.platform === "win32") {
	test("worker gh auth uses mixed-case AppData store on Windows", () => {
		if (!localGhAvailable()) return;
		const root = mkdtempSync(path.join(os.tmpdir(), "gh-auth-appdata-"));
		let capturedOut: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let capturedErr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		const adapter = openCodeAdapter();
		const preparation = adapter.prepare(spawnInput());
		try {
			const homeDir = path.join(root, "home");
			const appDataRoot = path.join(root, "appdata");
			writeGhHostsFixture(path.join(appDataRoot, "GitHub CLI"), "FAKE-GH-APPDATA-7d2f8b");
			writeGhHostsFixture(path.join(homeDir, ".config", "gh"), "FAKE-GH-HOME-4a9c3d");
			const workerEnv = buildWorkerEnv({
				PATH: process.env.PATH ?? "",
				HOME: homeDir,
				USERPROFILE: homeDir,
				AppData: appDataRoot,
			});
			const built = adapter.buildEnv(workerEnv, spawnInput(), preparation);
			assert.equal(built.GH_CONFIG_DIR, path.join(appDataRoot, "GitHub CLI"));
			const probed = readGhTokenSync(ghChildEnv(built, homeDir));
			capturedOut = probed.stdout;
			capturedErr = probed.stderr;
			assert.equal(probed.status, 0);
			assert.ok(capturedOut.toString("utf8").trim() === "FAKE-GH-APPDATA-7d2f8b");
		} finally {
			capturedOut.fill(0);
			capturedErr.fill(0);
			adapter.cleanupAgent(preparation.agentName, preparation);
			rmSync(root, { recursive: true, force: true });
		}
	});
}
