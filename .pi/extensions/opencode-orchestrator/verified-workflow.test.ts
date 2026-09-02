import assert from "node:assert/strict";
import test from "node:test";
import {
	buildVerifiedPhases,
	collectUnresolvedIssues,
	REQUIRE_RESOLVED_CONSTRAINT,
	REQUIRE_RESOLVED_GATE,
} from "./verified-workflow.ts";
import type { TaskSnapshot, WorkflowPhaseSpec } from "./types.ts";
import { validateWorkflowPhases } from "./types.ts";

function makeTaskSnapshot(overrides: Partial<TaskSnapshot> & { id: string }): TaskSnapshot {
	return {
		name: `task-${overrides.id}`,
		mode: "read_only",
		status: "done",
		objective: "x",
		relevantPaths: ["src"],
		scopes: ["src"],
		model: "m",
		backend: "opencode",
		createdAt: 0,
		output: "",
		stderr: "",
		activity: [],
		timedOut: false,
		truncated: false,
		report: { summary: "", files: [], findings: [], unresolved: [] },
		...overrides,
	};
}

test("buildVerifiedPhases generates implementer, tester, and reviewer phases in order", () => {
	const phases = buildVerifiedPhases({
		name: "feature-x",
		objective: "Implement feature X",
		relevantPaths: ["src/feature-x.ts"],
		expectedOutput: "Changed file plus summary",
	});
	assert.deepEqual(phases.map((phase) => phase.name), ["implement", "test", "review"]);
	const [implementer, tester, reviewer] = phases.map((phase) => phase.tasks[0]);
	assert.equal(implementer?.mode, "write");
	assert.equal(implementer?.role, "implementer");
	assert.equal(implementer?.objective, "Implement feature X");
	assert.equal(implementer?.expectedOutput, "Changed file plus summary");
	assert.equal(implementer?.model, undefined);
	assert.equal(tester?.mode, "read_only");
	assert.equal(tester?.role, "tester");
	assert.equal(reviewer?.mode, "read_only");
	assert.equal(reviewer?.role, "reviewer");
	for (const phase of phases) {
		assert.equal(phase.tasks.length, 1);
		assert.deepEqual(phase.tasks[0]?.relevantPaths, ["src/feature-x.ts"]);
	}
	assert.equal(implementer.name, "feature-x: implement");
	assert.equal(tester.name, "feature-x: test");
	assert.equal(reviewer.name, "feature-x: review");
});

test("buildVerifiedPhases attaches the requireResolved gate only to tester and reviewer phases", () => {
	const phases = buildVerifiedPhases({
		name: "gated",
		objective: "Objective",
		relevantPaths: ["src"],
		expectedOutput: "Evidence",
	});
	assert.deepEqual(phases.map((phase) => phase.requireResolved), [undefined, true, true]);
	const [, tester, reviewer] = phases.map((phase) => phase.tasks[0]);
	for (const task of [tester, reviewer]) {
		assert.ok(
			task?.constraints.includes(REQUIRE_RESOLVED_CONSTRAINT),
			`${task?.name} must carry the ${REQUIRE_RESOLVED_GATE} constraint`,
		);
	}
	const implementer = phases[0]?.tasks[0];
	assert.ok(!implementer?.constraints.includes(REQUIRE_RESOLVED_CONSTRAINT));
});

test("buildVerifiedPhases passes through models, constraints, and implementer-only worktree", () => {
	const phases = buildVerifiedPhases({
		name: "passthrough",
		objective: "Objective",
		relevantPaths: ["src/a.ts"],
		constraints: ["Do not touch README"],
		expectedOutput: "Evidence",
		worktree: true,
		implementerModel: "provider/impl",
		testerModel: "provider/test",
		reviewerModel: "provider/review",
	});
	const [implementer, tester, reviewer] = phases.map((phase) => phase.tasks[0]);
	assert.equal(implementer?.model, "provider/impl");
	assert.equal(implementer?.worktree, true);
	assert.deepEqual(implementer?.constraints, ["Do not touch README"]);
	assert.equal(tester?.model, "provider/test");
	assert.equal(tester?.worktree, undefined);
	assert.deepEqual(tester?.constraints, ["Do not touch README", REQUIRE_RESOLVED_CONSTRAINT]);
	assert.equal(reviewer?.model, "provider/review");
	assert.equal(reviewer?.worktree, undefined);
});

test("buildVerifiedPhases output satisfies validateWorkflowPhases, including worktree writes", () => {
	const cwd = process.cwd();
	const plain = buildVerifiedPhases({
		name: "validated",
		objective: "Objective",
		relevantPaths: ["src"],
		expectedOutput: "Evidence",
	});
	assert.doesNotThrow(() => validateWorkflowPhases(cwd, plain));
	const isolated = buildVerifiedPhases({
		name: "isolated",
		objective: "Objective",
		relevantPaths: ["src"],
		expectedOutput: "Evidence",
		worktree: true,
	});
	assert.doesNotThrow(() => validateWorkflowPhases(cwd, isolated));
});

test("collectUnresolvedIssues reports only workers with a non-empty unresolved report", () => {
	const results: TaskSnapshot[] = [
		makeTaskSnapshot({ id: "clean", report: { summary: "ok", files: [], findings: [], unresolved: [] } }),
		makeTaskSnapshot({ id: "gated", name: "tester", report: { summary: "ran", files: [], findings: [], unresolved: ["GATE_BLOCKER"] } }),
		makeTaskSnapshot({ id: "no-report" }),
	];
	const violations = collectUnresolvedIssues(results);
	assert.equal(violations.length, 1);
	assert.equal(violations[0]?.taskId, "gated");
	assert.equal(violations[0]?.taskName, "tester");
	assert.deepEqual(violations[0]?.unresolved, ["GATE_BLOCKER"]);
	assert.equal(collectUnresolvedIssues([]).length, 0);
});
