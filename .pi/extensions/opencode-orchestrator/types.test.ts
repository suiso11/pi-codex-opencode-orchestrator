import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import {
	buildWorkerPrompt,
	findScopeConflict,
	normalizeScopes,
	scopeOverlaps,
	validateWorkflowPhases,
} from "./types.ts";

const cwd = "/tmp/pi-opencode-test-repo";

test("normalizeScopes keeps concrete paths inside cwd", () => {
	assert.deepEqual(normalizeScopes(cwd, ["src/a.ts", "tests"]), [
		path.join(cwd, "src/a.ts"),
		path.join(cwd, "tests"),
	]);
	assert.throws(() => normalizeScopes(cwd, ["../secret"]), /escapes/);
	assert.throws(() => normalizeScopes(cwd, ["src/*.ts"]), /not globs/);
});

test("scope overlap is path-boundary aware", () => {
	assert.equal(scopeOverlaps(path.join(cwd, "src"), path.join(cwd, "src/a.ts")), true);
	assert.equal(scopeOverlaps(path.join(cwd, "src/a.ts"), path.join(cwd, "src/b.ts")), false);
	assert.equal(
		findScopeConflict(
			[path.join(cwd, "src")],
			[path.join(cwd, "src/a.ts")],
		)?.right,
		path.join(cwd, "src/a.ts"),
	);
});

test("worker prompt distinguishes read-only and write tasks", () => {
	const base = {
		name: "inspect",
		objective: "Inspect code",
		relevantPaths: ["src"],
		constraints: [],
		expectedOutput: "Findings",
	};
	assert.match(buildWorkerPrompt({ ...base, mode: "read_only" }), /Do not modify/);
	assert.match(buildWorkerPrompt({ ...base, mode: "write" }), /only within the declared relevant paths/);
});

test("workflow rejects overlapping write scopes in the same phase", () => {
	const write = (name: string, relevantPaths: string[]) => ({
		name,
		mode: "write" as const,
		objective: name,
		relevantPaths,
		constraints: [],
		expectedOutput: "result",
	});
	assert.throws(
		() => validateWorkflowPhases(cwd, [
			{ name: "edit", tasks: [write("parent", ["src"]), write("child", ["src/a.ts"])] },
			{ name: "verify", tasks: [{ ...write("verify", ["tests"]), mode: "read_only" as const }] },
		]),
		/overlap/,
	);
	assert.doesNotThrow(() => validateWorkflowPhases(cwd, [
		{ name: "edit", tasks: [write("a", ["src/a.ts"]), write("b", ["src/b.ts"])] },
		{ name: "verify", tasks: [{ ...write("verify", ["tests"]), mode: "read_only" as const }] },
	]));
});
