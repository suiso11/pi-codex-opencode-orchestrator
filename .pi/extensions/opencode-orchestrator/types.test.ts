import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	buildAgentFrontmatter,
	buildWorkerPrompt,
	configuredModelCapabilities,
	configuredModelProfiles,
	configuredTesterProfile,
	configuredThinkingLevel,
	DEFAULT_MODEL,
	decodeWorkerModel,
	DEFAULT_TOOL_PROFILE,
	encodeWorkerModel,
	enforceToolLimit,
	extractUsageFromEvent,
	findScopeConflict,
	mergeUsage,
	normalizeScopes,
	normalizeWorkerModelValue,
	pathForScopeComparison,
	parseWorkerReport,
	resolveModel,
	resolveThinkingLevel,
	resolveToolProfile,
	scopeOverlaps,
	taskResultText,
	taskResultsText,
	toolsForProfile,
	taskSummary,
	validateWorkflowPhases,
} from "./types.ts";
import type { TaskSnapshot } from "./types.ts";

const cwd = path.join(os.tmpdir(), "pi-opencode-test-repo");

test("worker model routes encode Pi opt-out without changing OpenCode model IDs", () => {
	assert.equal(encodeWorkerModel("opencode", "opencode-go/glm-5.2"), "opencode-go/glm-5.2");
	assert.equal(encodeWorkerModel("pi", "anthropic/claude-example"), "pi::anthropic/claude-example");
	assert.deepEqual(decodeWorkerModel("opencode-go/glm-5.2"), {
		backend: "opencode",
		model: "opencode-go/glm-5.2",
	});
	assert.deepEqual(decodeWorkerModel("pi::anthropic/claude-example"), {
		backend: "pi",
		model: "anthropic/claude-example",
	});
});

test("normalizeWorkerModelValue trims and collapses repeated opencode: prefixes while preserving pi::", () => {
	// Zero prefix: kept as-is (after trim).
	assert.equal(normalizeWorkerModelValue("opencode-go/glm-5.2"), "opencode-go/glm-5.2");
	// One prefix: stripped.
	assert.equal(normalizeWorkerModelValue("opencode:opencode-go/glm-5.2"), "opencode-go/glm-5.2");
	// Repeated prefixes: every leading "opencode:" is collapsed.
	assert.equal(normalizeWorkerModelValue("opencode:opencode:opencode-go/glm-5.2"), "opencode-go/glm-5.2");
	assert.equal(normalizeWorkerModelValue("  opencode:opencode:opencode-go/glm-5.2  "), "opencode-go/glm-5.2");
	// Pi values are preserved verbatim (after trim), never treated as OpenCode.
	assert.equal(normalizeWorkerModelValue("pi::anthropic/claude-example"), "pi::anthropic/claude-example");
	assert.equal(normalizeWorkerModelValue("  pi::anthropic/claude-example  "), "pi::anthropic/claude-example");
	// Values that normalize away entirely yield "".
	assert.equal(normalizeWorkerModelValue("opencode:"), "");
	assert.equal(normalizeWorkerModelValue("  "), "");
});

test("encode/decode yield a raw OpenCode snapshot model and the raw Pi model after pi:: decode", () => {
	assert.equal(encodeWorkerModel("opencode", "opencode-go/glm-5.2"), "opencode-go/glm-5.2");
	assert.equal(encodeWorkerModel("opencode", "opencode:opencode-go/glm-5.2"), "opencode-go/glm-5.2");
	assert.equal(encodeWorkerModel("opencode", "opencode:opencode:opencode-go/glm-5.2"), "opencode-go/glm-5.2");
	assert.equal(encodeWorkerModel("pi", "anthropic/claude-example"), "pi::anthropic/claude-example");
	assert.equal(encodeWorkerModel("pi", "pi::anthropic/claude-example"), "pi::anthropic/claude-example");
	assert.equal(encodeWorkerModel("pi", "opencode:anthropic/claude-example"), "pi::anthropic/claude-example");
	assert.deepEqual(decodeWorkerModel("opencode-go/glm-5.2"), { backend: "opencode", model: "opencode-go/glm-5.2" });
	assert.deepEqual(decodeWorkerModel("opencode:opencode-go/glm-5.2"), { backend: "opencode", model: "opencode-go/glm-5.2" });
	assert.deepEqual(decodeWorkerModel("pi::anthropic/claude-example"), { backend: "pi", model: "anthropic/claude-example" });
	assert.throws(() => encodeWorkerModel("opencode", ""), /must not be empty/);
	assert.throws(() => encodeWorkerModel("pi", "opencode:"), /must not be empty/);
	assert.throws(() => decodeWorkerModel("opencode:"), /must not be empty/);
});

test("model profiles resolve with explicit model precedence and environment overrides", () => {
	const profiles = configuredModelProfiles({
		PI_OPENCODE_PROFILE_IMPLEMENTER: "custom/implementer",
		PI_OPENCODE_PROFILE_REVIEWER: "custom/reviewer",
	});
	assert.equal(resolveModel({ profile: "implementer" }, "fallback/model", profiles), "custom/implementer");
	assert.equal(resolveModel({ profile: "reviewer" }, "fallback/model", profiles), "custom/reviewer");
	assert.equal(
		resolveModel({ model: "explicit/model", profile: "reviewer" }, "fallback/model", profiles),
		"explicit/model",
	);
	assert.equal(resolveModel({}, "fallback/model", profiles), "fallback/model");
	assert.throws(
		() => resolveModel({ profile: "missing" as never }, "fallback/model", profiles),
		/Unknown OpenCode model profile/,
	);
});

test("model precedence is explicit model, then explicit profile, then role-matching profile, then default worker", () => {
	const profiles = configuredModelProfiles({
		PI_OPENCODE_PROFILE_IMPLEMENTER: "custom/implementer",
		PI_OPENCODE_PROFILE_REVIEWER: "custom/reviewer",
	});
	const tester = "custom/tester";
	assert.equal(
		resolveModel({ model: "explicit/model", role: "tester" }, "fallback/model", profiles, tester),
		"explicit/model",
	);
	assert.equal(
		resolveModel({ model: "explicit/model", profile: "implementer", role: "tester" }, "fallback/model", profiles, tester),
		"explicit/model",
	);
	assert.equal(
		resolveModel({ profile: "implementer", role: "tester" }, "fallback/model", profiles, tester),
		"custom/implementer",
	);
	assert.equal(resolveModel({ role: "tester" }, "fallback/model", profiles, tester), "custom/tester");
	assert.equal(resolveModel({ role: "reviewer" }, "fallback/model", profiles, tester), "custom/reviewer");
	assert.equal(resolveModel({ role: "implementer" }, "fallback/model", profiles, tester), "custom/implementer");
	assert.equal(resolveModel({}, "fallback/model", profiles, tester), "fallback/model");
});

test("configuredTesterProfile uses PI_OPENCODE_PROFILE_TESTER with the default worker model fallback", () => {
	assert.equal(configuredTesterProfile({ PI_OPENCODE_PROFILE_TESTER: "custom/tester" }), "custom/tester");
	assert.equal(configuredTesterProfile({ PI_OPENCODE_PROFILE_TESTER: "  " }), DEFAULT_MODEL);
	assert.equal(configuredTesterProfile({}), DEFAULT_MODEL);
});

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

test("scope comparison is case-insensitive on Windows", () => {
	const parent = path.join(cwd, "src");
	const childWithDifferentCase = path.join(cwd, "SRC", "a.ts");
	assert.equal(
		pathForScopeComparison(childWithDifferentCase, "win32"),
		path.resolve(childWithDifferentCase).toLowerCase(),
	);
	if (process.platform === "win32") {
		assert.equal(scopeOverlaps(parent, childWithDifferentCase), true);
	}
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

test("workflow validates scopes of read-only tasks too, before any phase starts", () => {
	const readOnly = (name: string, relevantPaths: string[]) => ({
		name,
		mode: "read_only" as const,
		objective: name,
		relevantPaths,
		constraints: [],
		expectedOutput: "result",
	});
	assert.throws(
		() => validateWorkflowPhases(cwd, [
			{ name: "research", tasks: [readOnly("good", ["src"])] },
			{ name: "verify", tasks: [readOnly("bad-glob", ["src/*.ts"])] },
		]),
		/not globs/,
	);
	assert.throws(
		() => validateWorkflowPhases(cwd, [
			{ name: "research", tasks: [readOnly("good", ["src"])] },
			{ name: "verify", tasks: [readOnly("bad-escape", ["../secret"])] },
		]),
		/escapes/,
	);
	assert.throws(
		() => validateWorkflowPhases(cwd, [
			{ name: "research", tasks: [readOnly("bad-empty", ["  "])] },
			{ name: "verify", tasks: [readOnly("good", ["src"])] },
		]),
		/empty paths/,
	);
	assert.doesNotThrow(() => validateWorkflowPhases(cwd, [
		{ name: "research", tasks: [readOnly("a", ["src"]), readOnly("b", ["src/a.ts"])] },
		{ name: "verify", tasks: [readOnly("c", ["tests"])] },
	]));
});

test("buildWorkerPrompt requires a compact JSON report with structured fields", () => {
	const base = {
		name: "inspect",
		mode: "read_only" as const,
		objective: "Inspect code",
		relevantPaths: ["src"],
		constraints: [],
		expectedOutput: "Findings",
	};
	const prompt = buildWorkerPrompt(base);
	assert.match(prompt, /"summary"/);
	assert.match(prompt, /"files"/);
	assert.match(prompt, /"findings"/);
	assert.match(prompt, /"unresolved"/);
	assert.match(prompt, /2-4k characters/);
	assert.match(prompt, /No reasoning trace/);
});

test("parseWorkerReport accepts bare JSON, fenced JSON, embedded JSON, and falls back bounded", () => {
	const direct = parseWorkerReport(JSON.stringify({
		summary: "ok",
		files: ["a.ts", "b.ts"],
		findings: ["found issue"],
		unresolved: [],
	}));
	assert.equal(direct.summary, "ok");
	assert.deepEqual(direct.files, ["a.ts", "b.ts"]);
	assert.deepEqual(direct.findings, ["found issue"]);
	assert.deepEqual(direct.unresolved, []);

	const fenced = parseWorkerReport(
		`Here is my report:\n\`\`\`json\n${JSON.stringify({ summary: "fenced", files: [], findings: ["x"], unresolved: ["u"] })}\n\`\`\`\nDone.`,
	);
	assert.equal(fenced.summary, "fenced");
	assert.deepEqual(fenced.findings, ["x"]);
	assert.deepEqual(fenced.unresolved, ["u"]);

	const embedded = parseWorkerReport(
		`Reasoning text here.\n${JSON.stringify({ summary: "embedded", files: ["c.ts"], findings: [], unresolved: [] })}\nMore text.`,
	);
	assert.equal(embedded.summary, "embedded");
	assert.deepEqual(embedded.files, ["c.ts"]);

	const fallback = parseWorkerReport("just plain text output that is not JSON at all and has no braces");
	assert.ok(fallback.summary.includes("fallback"));
	assert.equal(fallback.findings.length, 1);
	assert.ok(fallback.findings[0].length <= 1_500);
	assert.equal(fallback.unresolved.length, 1);
	assert.ok(fallback.unresolved[0].includes("parsing failed"));
	assert.equal(fallback.files.length, 0);
});

test("parseWorkerReport returns empty report for blank input", () => {
	const report = parseWorkerReport("");
	assert.equal(report.summary, "");
	assert.deepEqual(report.files, []);
	assert.deepEqual(report.findings, []);
	assert.deepEqual(report.unresolved, []);
});

test("extractUsageFromEvent reads OpenCode step-finish and Pi message_end", () => {
	const oc = extractUsageFromEvent({
		type: "step_finish",
		part: {
			type: "step-finish",
			reason: "stop",
			tokens: {
				total: 250,
				input: 100,
				output: 50,
				reasoning: 70,
				cache: { write: 20, read: 10 },
			},
			cost: 0.003,
		},
	});
	assert.deepEqual(oc, {
		inputTokens: 100,
		outputTokens: 50,
		totalTokens: 250,
		reasoningTokens: 70,
		cacheReadTokens: 10,
		cacheWriteTokens: 20,
		cost: 0.003,
	});

	const pi = extractUsageFromEvent({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			usage: {
				input: 200,
				output: 80,
				cacheRead: 30,
				cacheWrite: 15,
				reasoning: 40,
				totalTokens: 280,
				cost: { total: 0.01 },
			},
		},
	});
	assert.equal(pi?.inputTokens, 200);
	assert.equal(pi?.outputTokens, 80);
	assert.equal(pi?.totalTokens, 280);
	assert.equal(pi?.reasoningTokens, 40);
	assert.equal(pi?.cacheReadTokens, 30);
	assert.equal(pi?.cacheWriteTokens, 15);
	assert.equal(pi?.cost, 0.01);

	const none = extractUsageFromEvent({ type: "text", part: { type: "text", text: "hi" } });
	assert.equal(none, undefined);
});

test("mergeUsage accumulates tokens, costs, cache, and reasoning across events", () => {
	const merged = mergeUsage(
		{ inputTokens: 10, cost: 0.01, cacheReadTokens: 5, reasoningTokens: 2 },
		{ inputTokens: 5, outputTokens: 3, cost: 0.02, cacheReadTokens: 7, cacheWriteTokens: 4, reasoningTokens: 1 },
	);
	assert.equal(merged.inputTokens, 15);
	assert.equal(merged.outputTokens, 3);
	assert.equal(merged.cost, 0.03);
	assert.equal(merged.cacheReadTokens, 12);
	assert.equal(merged.cacheWriteTokens, 4);
	assert.equal(merged.reasoningTokens, 3);
	assert.equal(merged.totalTokens, undefined);
});

test("configuredThinkingLevel reads PI_OPENCODE_THINKING and defaults to medium", () => {
	assert.equal(configuredThinkingLevel({}), "medium");
	assert.equal(configuredThinkingLevel({ PI_OPENCODE_THINKING: "high" }), "high");
	assert.equal(configuredThinkingLevel({ PI_OPENCODE_THINKING: "LOW" }), "low");
	assert.equal(configuredThinkingLevel({ PI_OPENCODE_THINKING: "bogus" }), "medium");
});

test("resolveThinkingLevel prefers spec over fallback", () => {
	assert.equal(resolveThinkingLevel({ thinking: "high" }, "medium"), "high");
	assert.equal(resolveThinkingLevel({}, "low"), "low");
});

test("resolveThinkingLevel forces high for reviewer and preserves explicit thinking for other roles", () => {
	assert.equal(resolveThinkingLevel({ role: "reviewer" }, "medium"), "high");
	assert.equal(resolveThinkingLevel({ role: "reviewer", thinking: "low" }, "medium"), "high");
	assert.equal(resolveThinkingLevel({ role: "tester", thinking: "low" }, "medium"), "low");
	assert.equal(resolveThinkingLevel({ role: "tester" }, "medium"), "medium");
	assert.equal(resolveThinkingLevel({ role: "implementer", thinking: "high" }, "medium"), "high");
	assert.equal(resolveThinkingLevel({ thinking: "high" }, "medium"), "high");
});

test("workflow rejects tester and reviewer roles in write mode", () => {
	const roleTask = (role: "tester" | "reviewer") => ({
		name: role,
		mode: "write" as const,
		objective: role,
		relevantPaths: ["src/a.ts"],
		constraints: [],
		expectedOutput: "result",
		role,
	});
	assert.throws(
		() => validateWorkflowPhases(cwd, [
			{ name: "edit", tasks: [roleTask("tester")] },
			{ name: "verify", tasks: [{ ...roleTask("tester"), mode: "read_only" as const }] },
		]),
		/requires read_only/,
	);
	assert.throws(
		() => validateWorkflowPhases(cwd, [
			{ name: "edit", tasks: [roleTask("reviewer")] },
			{ name: "verify", tasks: [{ ...roleTask("reviewer"), mode: "read_only" as const }] },
		]),
		/requires read_only/,
	);
	assert.doesNotThrow(() => validateWorkflowPhases(cwd, [
		{ name: "edit", tasks: [{ ...roleTask("tester"), mode: "read_only" as const }] },
		{ name: "verify", tasks: [{ ...roleTask("reviewer"), mode: "read_only" as const }] },
	]));
});

test("worker prompt documents tester mutation guard and reviewer read-only role", () => {
	const base = {
		name: "verify",
		mode: "read_only" as const,
		objective: "Verify",
		relevantPaths: ["src"],
		constraints: [],
		expectedOutput: "Findings",
	};
	const tester = buildWorkerPrompt({ ...base, role: "tester" });
	assert.match(tester, /Role: tester/);
	assert.match(tester, /mutation guard/);
	assert.match(tester, /outside-repo or ignored side effects are not prevented/);
	const reviewer = buildWorkerPrompt({ ...base, role: "reviewer" });
	assert.match(reviewer, /Role: reviewer/);
	assert.match(reviewer, /without modifying, creating, or deleting files/);
});

test("worktree prompt instructs isolated Git worktree only for write mode", () => {
	const write = {
		name: "implement",
		mode: "write" as const,
		objective: "Implement",
		relevantPaths: ["src"],
		constraints: [],
		expectedOutput: "result",
	};
	const isolated = buildWorkerPrompt({ ...write, worktree: true });
	assert.match(isolated, /isolated Git worktree/);
	assert.match(isolated, /Do not run git commit, reset, stash, add, or branch operations/);
	assert.doesNotMatch(isolated, /oc-worktrees/);
	const direct = buildWorkerPrompt({ ...write, worktree: false });
	assert.doesNotMatch(direct, /isolated Git worktree/);
	const readOnly = buildWorkerPrompt({ ...write, mode: "read_only", worktree: true });
	assert.doesNotMatch(readOnly, /isolated Git worktree/);
});

test("workflow validation propagates worktree isolation on write tasks", () => {
	const write = (name: string, relevantPaths: string[], worktree: boolean) => ({
		name,
		mode: "write" as const,
		objective: name,
		relevantPaths,
		constraints: [],
		expectedOutput: "result",
		worktree,
	});
	// Worktree write tasks with disjoint scopes validate; the field flows through the spec.
	assert.doesNotThrow(() => validateWorkflowPhases(cwd, [
		{ name: "edit", tasks: [write("a", ["src/a.ts"], true), write("b", ["src/b.ts"], true)] },
		{ name: "verify", tasks: [{ ...write("verify", ["tests"], false), mode: "read_only" as const }] },
	]));
	// Overlap checks still apply to worktree-isolated write tasks in the same phase.
	assert.throws(
		() => validateWorkflowPhases(cwd, [
			{ name: "edit", tasks: [write("a", ["src"], true), write("b", ["src/a.ts"], true)] },
			{ name: "verify", tasks: [{ ...write("verify", ["tests"], false), mode: "read_only" as const }] },
		]),
		/overlap/,
	);
});

test("workflow validation rejects worktree=true for read_only tasks", () => {
	const readOnly = (name: string) => ({
		name,
		mode: "read_only" as const,
		objective: name,
		relevantPaths: ["src"],
		constraints: [],
		expectedOutput: "result",
	});
	assert.throws(
		() => validateWorkflowPhases(cwd, [
			{ name: "edit", tasks: [{ ...readOnly("inspect"), worktree: true }] },
			{ name: "verify", tasks: [readOnly("verify")] },
		]),
		/requires mode write/,
	);
});

test("workflow validation rejects mixing direct writes, read-only, tester, and reviewer tasks into a worktree-write phase", () => {
	const worktreeWrite = (name: string, relevantPaths: string[]) => ({
		name,
		mode: "write" as const,
		objective: name,
		relevantPaths,
		constraints: [],
		expectedOutput: "result",
		worktree: true,
	});
	const readOnly = (name: string, role?: "tester" | "reviewer") => ({
		name,
		mode: "read_only" as const,
		objective: name,
		relevantPaths: ["src"],
		constraints: [],
		expectedOutput: "result",
		...(role ? { role } : {}),
	});
	// A direct (non-worktree) write mixed into a worktree-write phase is rejected.
	assert.throws(
		() => validateWorkflowPhases(cwd, [
			{
				name: "edit",
				tasks: [
					worktreeWrite("isolated", ["src/a.ts"]),
					{ ...worktreeWrite("direct", ["src/b.ts"]), worktree: false },
				],
			},
			{ name: "verify", tasks: [readOnly("verify")] },
		]),
		/mixes worktree-isolated writes with other tasks/,
	);
	// A plain read-only task mixed into a worktree-write phase is rejected.
	assert.throws(
		() => validateWorkflowPhases(cwd, [
			{ name: "edit", tasks: [worktreeWrite("isolated", ["src/a.ts"]), readOnly("inspect")] },
			{ name: "verify", tasks: [readOnly("verify")] },
		]),
		/mixes worktree-isolated writes with other tasks/,
	);
	// A tester task mixed into a worktree-write phase is rejected.
	assert.throws(
		() => validateWorkflowPhases(cwd, [
			{ name: "edit", tasks: [worktreeWrite("isolated", ["src/a.ts"]), readOnly("test", "tester")] },
			{ name: "verify", tasks: [readOnly("verify")] },
		]),
		/mixes worktree-isolated writes with other tasks/,
	);
	// A reviewer task mixed into a worktree-write phase is rejected.
	assert.throws(
		() => validateWorkflowPhases(cwd, [
			{ name: "edit", tasks: [worktreeWrite("isolated", ["src/a.ts"]), readOnly("review", "reviewer")] },
			{ name: "verify", tasks: [readOnly("verify")] },
		]),
		/mixes worktree-isolated writes with other tasks/,
	);
	// Multiple disjoint worktree writes in the same phase remain allowed.
	assert.doesNotThrow(() => validateWorkflowPhases(cwd, [
		{ name: "edit", tasks: [worktreeWrite("a", ["src/a.ts"]), worktreeWrite("b", ["src/b.ts"])] },
		{ name: "verify", tasks: [readOnly("verify")] },
	]));
});

test("workflow validation rejects a second worktree-write phase", () => {
	const worktreeWrite = (name: string, relevantPaths: string[]) => ({
		name,
		mode: "write" as const,
		objective: name,
		relevantPaths,
		constraints: [],
		expectedOutput: "result",
		worktree: true,
	});
	const readOnly = (name: string) => ({
		name,
		mode: "read_only" as const,
		objective: name,
		relevantPaths: ["src"],
		constraints: [],
		expectedOutput: "result",
	});
	assert.throws(
		() => validateWorkflowPhases(cwd, [
			{ name: "edit-a", tasks: [worktreeWrite("a", ["src/a.ts"])] },
			{ name: "edit-b", tasks: [worktreeWrite("b", ["src/b.ts"])] },
			{ name: "verify", tasks: [readOnly("verify")] },
		]),
		/at most one worktree-write phase/,
	);
});

test("workflow validation rejects a worktree-write phase after an earlier direct/write phase", () => {
	const directWrite = (name: string, relevantPaths: string[]) => ({
		name,
		mode: "write" as const,
		objective: name,
		relevantPaths,
		constraints: [],
		expectedOutput: "result",
	});
	const worktreeWrite = (name: string, relevantPaths: string[]) => ({
		...directWrite(name, relevantPaths),
		worktree: true,
	});
	const readOnly = (name: string) => ({
		name,
		mode: "read_only" as const,
		objective: name,
		relevantPaths: ["src"],
		constraints: [],
		expectedOutput: "result",
	});
	assert.throws(
		() => validateWorkflowPhases(cwd, [
			{ name: "direct", tasks: [directWrite("d", ["src/d.ts"])] },
			{ name: "worktree", tasks: [worktreeWrite("w", ["src/w.ts"])] },
			{ name: "verify", tasks: [readOnly("verify")] },
		]),
		/must be preceded only by read-only phases/,
	);
});

test("workflow validation allows a read-only phase, one worktree-write phase, then later read-only/direct-write phases", () => {
	const worktreeWrite = (name: string, relevantPaths: string[]) => ({
		name,
		mode: "write" as const,
		objective: name,
		relevantPaths,
		constraints: [],
		expectedOutput: "result",
		worktree: true,
	});
	const directWrite = (name: string, relevantPaths: string[]) => ({
		name,
		mode: "write" as const,
		objective: name,
		relevantPaths,
		constraints: [],
		expectedOutput: "result",
	});
	const readOnly = (name: string) => ({
		name,
		mode: "read_only" as const,
		objective: name,
		relevantPaths: ["src"],
		constraints: [],
		expectedOutput: "result",
	});
	// Read-only before, one worktree-write in the middle, then read-only and a
	// direct-write after the worktree phase — all allowed.
	assert.doesNotThrow(() => validateWorkflowPhases(cwd, [
		{ name: "inspect", tasks: [readOnly("inspect")] },
		{ name: "isolated", tasks: [worktreeWrite("w", ["src/w.ts"])] },
		{ name: "verify", tasks: [readOnly("verify")] },
		{ name: "apply", tasks: [directWrite("apply", ["src/apply.ts"])] },
	]));
	// Multiple disjoint worktree writes in the single worktree phase still validate.
	assert.doesNotThrow(() => validateWorkflowPhases(cwd, [
		{ name: "inspect", tasks: [readOnly("inspect")] },
		{ name: "isolated", tasks: [worktreeWrite("a", ["src/a.ts"]), worktreeWrite("b", ["src/b.ts"])] },
		{ name: "verify", tasks: [readOnly("verify")] },
	]));
});

function fakeSnapshot(output: string, report?: TaskSnapshot["report"]): TaskSnapshot {
	return {
		id: "oc-test",
		name: "test",
		mode: "read_only",
		status: "done",
		objective: "o",
		relevantPaths: ["src"],
		scopes: [],
		model: "m",
		backend: "opencode",
		createdAt: 0,
		settledAt: 1,
		output,
		stderr: "",
		activity: [],
		timedOut: false,
		truncated: false,
		report,
	};
}

test("taskResultText and taskResultsText default to 8000 character budget", () => {
	const task = fakeSnapshot("x".repeat(20_000));
	const single = taskResultText(task);
	assert.ok(single.length <= 8_000, `single len=${single.length}`);
	const multi = taskResultsText([task]);
	assert.ok(multi.length <= 8_000, `multi len=${multi.length}`);
});

test("taskResultText includes observed task usage within the compact result", () => {
	const task = fakeSnapshot("", { summary: "done", files: [], findings: [], unresolved: [] });
	task.usage = {
		inputTokens: 9_693,
		outputTokens: 3,
		totalTokens: 9_772,
		cacheReadTokens: 76,
		reasoningTokens: 0,
		cost: 0.01360316,
	};
	const text = taskResultText(task);
	assert.match(text, /Usage: in 9,693 · out 3 · total 9,772/);
	assert.match(text, /cache read 76/);
	assert.match(text, /cost 0\.013603/);
	assert.ok(text.length <= 8_000);
});

test("taskResultText prefers structured report over raw output", () => {
	const task = fakeSnapshot("raw output that should not appear", {
		summary: "compact summary",
		files: ["a.ts"],
		findings: ["finding one"],
		unresolved: ["blocker"],
	});
	const text = taskResultText(task);
	assert.match(text, /compact summary/);
	assert.match(text, /a\.ts/);
	assert.match(text, /finding one/);
	assert.match(text, /blocker/);
	assert.doesNotMatch(text, /raw output that should not appear/);
});

test("taskResultText falls back to bounded raw output when no report", () => {
	const task = fakeSnapshot("short raw output");
	const text = taskResultText(task);
	assert.match(text, /short raw output/);
});

test("taskResultText and taskResultsText never exceed requested maxChars, including very small budgets", () => {
	const task = fakeSnapshot("x".repeat(20_000));
	for (const budget of [0, 1, 5, 24, 100, 1_000, 8_000]) {
		const single = taskResultText(task, budget);
		assert.ok(single.length <= budget, `single budget=${budget} len=${single.length}`);
	}
	for (const budget of [0, 1, 10, 50, 500, 8_000]) {
		const multi = taskResultsText([task, task, task], budget);
		assert.ok(multi.length <= budget, `multi budget=${budget} len=${multi.length}`);
	}
	const empty = taskResultsText([], 3);
	assert.ok(empty.length <= 3, `empty len=${empty.length}`);
});

test("tool profiles map to the expected tool sets", () => {
	assert.deepEqual([...toolsForProfile("minimal", "write")], ["read", "glob", "grep"]);
	assert.deepEqual([...toolsForProfile("coding", "write")], ["read", "glob", "grep", "edit", "bash"]);
	// read_only strips edit and bash even when the profile would include them
	assert.deepEqual([...toolsForProfile("coding", "read_only")], ["read", "glob", "grep"]);
	assert.deepEqual([...toolsForProfile("research", "write")], ["read", "glob", "grep", "webfetch", "websearch"]);
	assert.deepEqual([...toolsForProfile("research", "read_only")], ["read", "glob", "grep", "webfetch", "websearch"]);
	assert.ok(toolsForProfile("full", "write").length > toolsForProfile("coding", "write").length);
});

test("resolveToolProfile prefers spec over fallback", () => {
	assert.equal(resolveToolProfile({ toolProfile: "research" }, "coding"), "research");
	assert.equal(resolveToolProfile({}, "coding"), "coding");
	assert.equal(resolveToolProfile({}, DEFAULT_TOOL_PROFILE), DEFAULT_TOOL_PROFILE);
});

test("enforceToolLimit keeps tools when within capability and trims when over", () => {
	const within = enforceToolLimit(["read", "glob", "grep"], { maxTools: 16 });
	assert.equal(within.reduced, false);
	assert.deepEqual(within.tools, ["read", "glob", "grep"]);
	const over = enforceToolLimit(["read", "glob", "grep", "edit", "bash"], { maxTools: 3 });
	assert.equal(over.reduced, true);
	assert.equal(over.tools.length, 3);
	assert.ok(over.reason?.includes("exceeds"));
	// no capability means no limit
	const noCap = enforceToolLimit(["a", "b", "c"], undefined);
	assert.equal(noCap.reduced, false);
});

test("configuredModelCapabilities reads PI_OPENCODE_MODEL_CAP_ env overrides", () => {
	const caps = configuredModelCapabilities({
		"PI_OPENCODE_MODEL_CAP_opencode-go__deepseek-v4-flash": "maxTools=8,toolSchema=restricted",
	});
	assert.equal(caps["opencode-go/deepseek-v4-flash"]?.maxTools, 8);
	assert.equal(caps["opencode-go/deepseek-v4-flash"]?.toolSchema, "restricted");
	// built-in default still present
	assert.equal(caps["opencode-go/deepseek-v4-flash"]?.maxTools, 8);
});

test("buildAgentFrontmatter denies tools outside the profile and allows the rest", () => {
	const coding = buildAgentFrontmatter("coding", "write");
	assert.match(coding, /^---\ndescription:/);
	assert.match(coding, /mode: primary/);
	// edit and read are allowed (no deny line for them)
	assert.doesNotMatch(coding, /\nread: deny/);
	assert.doesNotMatch(coding, /\nedit: deny/);
	// webfetch, websearch, task, todowrite, lsp, skill are denied
	assert.match(coding, /webfetch: deny/);
	assert.match(coding, /websearch: deny/);
	assert.match(coding, /task: deny/);
	assert.match(coding, /todowrite: deny/);
	assert.match(coding, /lsp: deny/);
	assert.match(coding, /skill: deny/);
	// read_only mode denies bash and edit too
	const ro = buildAgentFrontmatter("coding", "read_only");
	assert.match(ro, /bash: deny/);
	assert.match(ro, /edit: deny/);
	// full profile denies nothing
	const full = buildAgentFrontmatter("full", "write");
	assert.doesNotMatch(full, /: deny/);
});

test("taskSummary and taskResultText expose worktree state without leaking the worktree path", () => {
	const task = fakeSnapshot("raw", { summary: "done", files: ["a.ts"], findings: [], unresolved: [] });
	task.worktree = { isolated: true, baseHead: "abc1234", status: "integrated", changedPaths: ["a.ts"] };
	assert.match(taskSummary(task), /\[worktree:integrated\]/);
	assert.equal("path" in task.worktree, false, "the worktree path must not be part of the public snapshot");
	const text = taskResultText(task);
	assert.match(text, /\[worktree:integrated\]/);
	assert.doesNotMatch(text, /oc-worktrees|abc1234/, "worktree path/base head must not leak into result text");
	assert.doesNotMatch(taskSummary(task), /oc-worktrees/, "worktree path must not leak into status text");
});

test("taskSummary renders exactly one backend prefix, never doubling legacy prefixes", () => {
	const summary = (backend: "opencode" | "pi", model: string) =>
		taskSummary({ ...fakeSnapshot(""), backend, model });
	// Legacy snapshots may persist a stray display prefix (or several): the
	// summary must still show exactly "opencode:provider/model", not doubled.
	for (const model of ["provider/model", "opencode:provider/model", "opencode:opencode:provider/model"]) {
		const text = summary("opencode", model);
		assert.match(text, /\(0s, opencode:provider\/model\)$/);
		assert.doesNotMatch(text, /opencode:opencode/);
	}
	// Pi snapshots keep their wrapper or not; repeated "pi::" is collapsed so
	// the display label is exactly "pi:provider/model".
	for (const model of ["pi::provider/model", "provider/model", "pi::pi::provider/model"]) {
		const text = summary("pi", model);
		assert.match(text, /\(0s, pi:provider\/model\)$/);
		assert.doesNotMatch(text, /pi:pi::/);
	}
});
