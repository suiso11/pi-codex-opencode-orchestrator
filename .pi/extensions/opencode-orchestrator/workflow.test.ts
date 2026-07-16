import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { OpenCodeTaskManager } from "./manager.ts";
import type { WorkflowPhaseSpec } from "./types.ts";
import { OpenCodeWorkflowManager } from "./workflow.ts";

async function fakeOpenCode() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "fake-opencode-workflow-"));
	const script = path.join(dir, "opencode.mjs");
	await writeFile(
		script,
		`
const prompt = process.argv.at(-1) || "";
let text = "PHASE_ONE_RESULT";
if (prompt.includes("second phase")) {
  text = prompt.includes("Previous phase results") && prompt.includes("PHASE_ONE_RESULT")
    ? "HAS_PRIOR_CONTEXT"
    : "MISSING_PRIOR_CONTEXT";
}
process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text } }) + "\\n");
`,
	);
	return {
		binary: process.execPath,
		binaryArgs: [script],
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

test("workflow runs phases sequentially and passes bounded prior results forward", async () => {
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
				objective: "first phase",
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
				objective: "second phase",
				relevantPaths: ["src"],
				constraints: [],
				expectedOutput: "integrated result",
				profile: "qwen_max",
			}],
		},
	];

	try {
		const started = workflows.start("context handoff", phases, process.cwd());
		const settled = await workflows.wait(started.id);
		assert.equal(settled.status, "done");
		assert.equal(settled.taskIds.length, 2);
		assert.match(tasks.get(settled.taskIds[0])?.output ?? "", /PHASE_ONE_RESULT/);
		assert.match(tasks.get(settled.taskIds[1])?.output ?? "", /HAS_PRIOR_CONTEXT/);
		assert.equal(tasks.get(settled.taskIds[1])?.model, "opencode-go/qwen3.7-max");
	} finally {
		await workflows.dispose();
		await tasks.dispose();
		await fake.cleanup();
	}
});
