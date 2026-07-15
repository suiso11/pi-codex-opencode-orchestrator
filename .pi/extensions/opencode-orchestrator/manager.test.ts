import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { OpenCodeTaskManager } from "./manager.ts";

async function fakeOpenCode() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "fake-opencode-"));
	const binary = path.join(dir, "opencode");
	await writeFile(
		binary,
		`#!/usr/bin/env node
const prompt = process.argv.at(-1) || "";
const delay = prompt.includes("slow") ? 500 : 20;
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text: "FAKE_OK" } }) + "\\n");
}, delay);
`,
	);
	await chmod(binary, 0o755);
	return { binary, cleanup: () => rm(dir, { recursive: true, force: true }) };
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
	const manager = new OpenCodeTaskManager({ binary: fake.binary, timeoutMs: 2_000 });
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
	const manager = new OpenCodeTaskManager({ binary: fake.binary, timeoutMs: 2_000 });
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
