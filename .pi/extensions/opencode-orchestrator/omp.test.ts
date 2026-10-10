import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ompExtension from "./omp.ts";

function runtime() {
	const handlers = new Map<string, (...args: any[]) => any>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	let active = ["read", "grep", "glob", "bash", "edit", "task", "wait"];
	const api = {
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getActiveTools: () => active,
		setActiveTools: async (names: string[]) => { await Promise.resolve(); active = names; },
		sendMessage: () => {},
	};
	ompExtension(api as unknown as ExtensionAPI);
	const ctx = {agent: {depth: 0}, mode: "tui", cwd: process.cwd(), isIdle: () => false};
	return {handlers, tools, commands, ctx, active: () => active};
}

test("OMP prompt conversion awaits tool activation and preserves native coordination", async () => {
	const r = runtime();
	const result = await r.handlers.get("before_agent_start")!({systemPrompt: ["first", "second"]}, r.ctx);
	assert.ok(Array.isArray(result.systemPrompt));
	assert.match(result.systemPrompt[0], /first\n\nsecond/);
	assert.match(result.systemPrompt[0], /through OMP task or opencode_\* tools/);
	assert.match(result.systemPrompt[0], /isolated: true/);
	assert.ok(r.active().includes("glob"));
	assert.ok(r.active().includes("task"));
	assert.ok(r.active().includes("wait"));
	for (const name of ["find", "ls", "bash", "edit"]) assert.ok(!r.active().includes(name));
	const again = await r.handlers.get("before_agent_start")!({systemPrompt: result.systemPrompt}, r.ctx);
	assert.equal(again, undefined, "coordinator policy must not duplicate");
	await r.handlers.get("session_shutdown")!({}, r.ctx);
});

test("OMP native glob/task/wait pass the parent gate while direct edits remain blocked", async () => {
	const r = runtime();
	for (const toolName of ["read", "grep", "glob", "task", "wait", "opencode_spawn"]) {
		assert.equal(await r.handlers.get("tool_call")!({toolName}, r.ctx), undefined);
	}
	for (const path of ["agent://Worker", "proc://job", "local://handoff.md"]) {
		assert.equal(await r.handlers.get("tool_call")!({toolName: "write", input: {path}}, r.ctx), undefined);
	}
	assert.equal((await r.handlers.get("tool_call")!({toolName: "write", input: {path: "src/app.ts"}}, r.ctx)).block, true);
	for (const toolName of ["bash", "write", "edit", "computer", "opencode_unregistered"]) {
		assert.equal((await r.handlers.get("tool_call")!({toolName}, r.ctx)).block, true);
	}
	await r.handlers.get("session_shutdown")!({}, r.ctx);
});

test("OMP native workers keep their own editing tools and prompts", async () => {
	const r = runtime();
	for (const agent of [{depth: 1}, {depth: 0, parentId: "parent"}]) {
		const ctx = {...r.ctx, agent};
		assert.equal(await r.handlers.get("tool_call")!({toolName: "edit"}, ctx), undefined);
		assert.equal(await r.handlers.get("before_agent_start")!({systemPrompt: ["worker"]}, ctx), undefined);
	}
	assert.ok(r.active().includes("edit"), "child hooks must not change its tools");
	await r.handlers.get("session_shutdown")!({}, r.ctx);
});

test("OMP optional tool activation preserves native tools and async completion", async () => {
	const r = runtime();
	await r.tools.get("opencode_tools").execute("activate", {group: "inspection"}, undefined, undefined, r.ctx);
	for (const name of ["opencode_output", "task", "wait", "glob"]) assert.ok(r.active().includes(name));
	assert.ok(!r.active().some(name => name.includes("worktree")));
	assert.ok(r.handlers.has("agent_end"));
	assert.ok(!r.handlers.has("agent_settled"));
	assert.ok(r.commands.has("orch-model"));
	await r.handlers.get("session_shutdown")!({}, r.ctx);
});
