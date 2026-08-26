import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { OpenCodeTaskManager } from "./manager.ts";

async function fakeOpenCode() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "fake-opencode-"));
	const script = path.join(dir, "opencode.mjs");
	await writeFile(
		script,
		`
const prompt = process.argv.at(-1) || "";
const delay = prompt.includes("slow") ? 500 : 20;
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

test("manager runs read-only and disjoint write tasks concurrently", async () => {
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

		const writeA = manager.spawn(spec("write-a", "write", ["src/a.ts"], "slow write a"), process.cwd());
		const writeB = manager.spawn(spec("write-b", "write", ["src/b.ts"], "slow write b"), process.cwd());
		assert.equal(manager.runningCount(), 2);
		assert.throws(
			() => manager.spawn(spec("write-parent", "write", ["src"]), process.cwd()),
			/conflicts/,
		);
		await manager.cancel([writeA.id, writeB.id]);
		assert.equal(manager.get(writeA.id)?.status, "cancelled");
		assert.equal(manager.get(writeB.id)?.status, "cancelled");
	} finally {
		await manager.dispose();
		await fake.cleanup();
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
		manager.setModelSetting("glm", "example/glm");
		manager.setModelSetting("kimi_k3", "example/kimi");
		assert.deepEqual(manager.configuration().model, "example/default");
		assert.deepEqual(manager.configuration().profiles, {
			glm: "example/glm",
			kimi_k3: "example/kimi",
		});
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
