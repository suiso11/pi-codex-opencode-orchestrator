import assert from "node:assert/strict";
import test from "node:test";
import {
	pruneOrchestrationResults,
	type OrchestrationResultLike,
} from "./context-pruning.ts";

function toolResult(toolName: string, content: string, overrides: Partial<OrchestrationResultLike> = {}): OrchestrationResultLike {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName,
		content: [{ type: "text", text: content }],
		...overrides,
	};
}

function customBatch(content: string, details?: unknown): OrchestrationResultLike {
	return {
		role: "custom",
		customType: "opencode-batch-result",
		content,
		display: true,
		details,
	};
}

function user(content = "hi"): OrchestrationResultLike {
	return { role: "user", content };
}

test("prunes old opencode_ toolResult only after a newer user message exists", () => {
	const messages = [
		user(),
		toolResult("opencode_wait", "x".repeat(500), { toolCallId: "call-old" }),
		user("second turn"),
		toolResult("opencode_task", "y".repeat(200), { toolCallId: "call-1" }),
	];
	const result = pruneOrchestrationResults(messages);
	assert.equal(result.prunedMessages, 1);
	const pruned = result.messages[1];
	const placeholder = (pruned.content as { text: string }[])[0].text;
	assert.equal(result.charsRemoved, 500 - placeholder.length);
	assert.equal(pruned.toolCallId, "call-old");
	assert.equal(pruned.toolName, "opencode_wait");
	assert.match(placeholder, /pruned to preserve context/);
	const current = result.messages[3];
	assert.equal((current.content as { text: string }[])[0].text, "y".repeat(200));
});

test("protects the immediate current result when no newer user message exists", () => {
	const messages = [
		user(),
		toolResult("opencode_wait", "x".repeat(500)),
	];
	const result = pruneOrchestrationResults(messages);
	assert.equal(result.prunedMessages, 0);
	assert.equal(result.charsRemoved, 0);
	assert.equal((result.messages[1].content as { text: string }[])[0].text, "x".repeat(500));
});

test("prunes old custom opencode-batch-result and preserves its workflow ids", () => {
	const messages = [
		user(),
		customBatch("batch content ".repeat(50), {
			tasks: [{ id: "oc-1", status: "done" }],
			workflows: [{ id: "ow-9", status: "done" }],
		}),
		user("next turn"),
	];
	const result = pruneOrchestrationResults(messages);
	assert.equal(result.prunedMessages, 1);
	const placeholder = result.messages[1].content as string;
	assert.equal(result.charsRemoved, "batch content ".repeat(50).length - placeholder.length);
	assert.match(placeholder, /ow-9/);
	assert.match(result.messages[1].content as string, /oc-1/);
	assert.equal(result.messages[1].role, "custom");
	assert.equal(result.messages[1].customType, "opencode-batch-result");
});

test("preserves non-target messages, ordering, and other tool results", () => {
	const messages = [
		user(),
		toolResult("opencode_wait", "x".repeat(300)),
		toolResult("read", "file contents"),
		user("next"),
		toolResult("opencode_list", "y".repeat(100)),
	];
	const result = pruneOrchestrationResults(messages);
	assert.equal(result.prunedMessages, 1);
	const placeholder = (result.messages[1].content as { text: string }[])[0].text;
	assert.equal(result.charsRemoved, 300 - placeholder.length);
	assert.equal(result.messages.length, messages.length);
	assert.equal((result.messages[2].content as { text: string }[])[0].text, "file contents");
	assert.equal((result.messages[4].content as { text: string }[])[0].text, "y".repeat(100));
	assert.deepEqual(
		result.messages.map((m) => m.role),
		["user", "toolResult", "toolResult", "user", "toolResult"],
	);
});

test("prunes nothing when there is no real user message", () => {
	const messages = [
		toolResult("opencode_wait", "x".repeat(300)),
		customBatch("y".repeat(200)),
	];
	const result = pruneOrchestrationResults(messages);
	assert.equal(result.prunedMessages, 0);
	assert.equal(result.charsRemoved, 0);
	assert.deepEqual(result.messages, messages);
});

test("returns empty stats for an empty message list", () => {
	const result = pruneOrchestrationResults([]);
	assert.equal(result.prunedMessages, 0);
	assert.equal(result.charsRemoved, 0);
	assert.deepEqual(result.messages, []);
});
