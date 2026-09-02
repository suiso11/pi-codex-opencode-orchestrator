import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import type { OpenCodeTaskManager } from "./manager.ts";
import {
	applyExternalModelSetting,
	chooseModel,
	ModelConfigSync,
	registerModelCommand,
	type ModelConfigContextLike,
	type ModelConfigManagerLike,
	type ModelConfigPiLike,
} from "./model-command.ts";

function tempDir(label: string) {
	return join(tmpdir(), `pi-orch-model-command-test-${label}-${process.pid}-${Date.now()}`);
}

// The custom picker's handleInput consumes raw terminal bytes, so derive the
// exact legacy control byte for the advertised Ctrl+E shortcut from the same
// public Key.ctrl(...) identifier the implementation binds.
function ctrlByte(keyId: `ctrl+${string}`) {
	const letter = keyId.slice("ctrl+".length);
	return String.fromCharCode(letter.charCodeAt(0) - 96);
}

interface FakeUi {
	messages: Array<{ message: string; type: string }>;
	notify(message: string, type?: string): void;
}

function makeFakeUi(): FakeUi {
	const messages: Array<{ message: string; type: string }> = [];
	return {
		messages,
		notify(message: string, type?: "info" | "warning" | "error") {
			messages.push({ message, type: type ?? "info" });
		},
	};
}

interface FakeRegistry {
	models: Array<{ provider: string; id: string }>;
	refreshes: number;
	find(provider: string, modelId: string): { provider: string; id: string } | undefined;
	refresh(): Promise<void>;
}

function makeRegistry(models: Array<{ provider: string; id: string }>, failRefresh = false): FakeRegistry {
	const registry: FakeRegistry = {
		models,
		refreshes: 0,
		find(provider: string, modelId: string) {
			return models.find((m) => m.provider === provider && m.id === modelId);
		},
		async refresh() {
			registry.refreshes += 1;
			if (failRefresh) throw new Error("registry exploded");
		},
	};
	return registry;
}

class FakeManager implements ModelConfigManagerLike {
	defaultModel = "opencode-go/glm-5.2";
	profiles = { implementer: "opencode-go/glm-5.2", reviewer: "opencode-go/kimi-k3" };
	testerProfile = "opencode-go/glm-5.2";
	applied: Array<[string, string]> = [];
	configuration() {
		return {
			model: this.defaultModel,
			profiles: this.profiles,
			testerProfile: this.testerProfile,
		};
	}
	setModelSetting(target: "worker" | "implementer" | "reviewer" | "tester", model: string) {
		this.applied.push([target, model]);
		if (target === "worker") this.defaultModel = model;
		else if (target === "tester") this.testerProfile = model;
		else this.profiles[target] = model;
	}
}

class FakeParent implements ModelConfigPiLike {
	active: { provider: string; id: string };
	failNext = false;
	throwNext = false;
	setModelCalls = 0;
	constructor(active: { provider: string; id: string } = { provider: "openai-codex", id: "gpt-5.6-sol" }) {
		this.active = active;
	}
	async setModel(model: { provider: string; id: string }) {
		this.setModelCalls += 1;
		if (this.throwNext) throw new Error("setModel failed");
		if (this.failNext) return false;
		this.active = model;
		return true;
	}
}

function makeContext(options: {
	parent?: FakeParent;
	manager: FakeManager;
	registry?: FakeRegistry;
	ui?: FakeUi;
}): ModelConfigContextLike {
	const ui = options.ui ?? makeFakeUi();
	const parent = options.parent ?? new FakeParent();
	const manager = options.manager;
	return {
		model: parent.active ? { ...parent.active } : undefined,
		modelRegistry: options.registry ?? makeRegistry([]),
		ui,
	};
}

test("applyExternalModelSetting applies worker/profile settings for future tasks only", async () => {
	const ui = makeFakeUi();
	const manager = new FakeManager();
	const ctx = makeContext({ manager, ui });
	const ok = await applyExternalModelSetting(
		new FakeParent(),
		"implementer",
		" opencode-go/new-model ",
		ctx,
		manager,
		(message, type) => ui.notify(message, type),
	);
	assert.equal(ok, true);
	assert.deepEqual(manager.applied, [["implementer", "opencode-go/new-model"]]);
	assert.match(ui.messages[0]!.message, /Implementer profile updated/);
});

test("applyExternalModelSetting applies tester through manager.setModelSetting", async () => {
	const ui = makeFakeUi();
	const manager = new FakeManager();
	const ctx = makeContext({ manager, ui });
	const ok = await applyExternalModelSetting(
		new FakeParent(),
		"tester",
		" opencode-go/tester-model ",
		ctx,
		manager,
		(message, type) => ui.notify(message, type),
	);
	assert.equal(ok, true);
	assert.deepEqual(manager.applied, [["tester", "opencode-go/tester-model"]]);
	assert.equal(manager.testerProfile, "opencode-go/tester-model");
	assert.match(ui.messages[0]!.message, /Tester profile updated/);
});

test("applyExternalModelSetting rejects invalid worker values without touching the manager", async () => {
	const ui = makeFakeUi();
	const manager = new FakeManager();
	const ctx = makeContext({ manager, ui });
	const ok = await applyExternalModelSetting(
		new FakeParent(),
		"worker",
		"bad value with spaces",
		ctx,
		manager,
		(message, type) => ui.notify(message, type),
	);
	assert.equal(ok, false);
	assert.deepEqual(manager.applied, []);
	assert.match(ui.messages[0]!.message, /invalid worker model/);
});

test("applyExternalModelSetting keeps the current parent model when unavailable or unauthenticated", async () => {
	const ui = makeFakeUi();
	const parent = new FakeParent();
	parent.failNext = true;
	const registry = makeRegistry([{ provider: "anthropic", id: "claude-sonnet-4-5" }]);
	const ctx = makeContext({ parent, manager: new FakeManager(), registry, ui });

	let ok = await applyExternalModelSetting(
		parent,
		"parent",
		"not-a-provider-model",
		ctx,
		new FakeManager(),
		(message, type) => ui.notify(message, type),
	);
	assert.equal(ok, false);
	assert.equal(parent.setModelCalls, 0);

	ok = await applyExternalModelSetting(
		parent,
		"parent",
		"missing/model",
		ctx,
		new FakeManager(),
		(message, type) => ui.notify(message, type),
	);
	assert.equal(ok, false);
	assert.equal(parent.setModelCalls, 0);
	assert.match(ui.messages.at(-1)!.message, /not available/);

	ok = await applyExternalModelSetting(
		parent,
		"parent",
		"anthropic/claude-sonnet-4-5",
		ctx,
		new FakeManager(),
		(message, type) => ui.notify(message, type),
	);
	assert.equal(ok, false);
	assert.equal(parent.setModelCalls, 1);
	assert.equal(parent.active.id, "gpt-5.6-sol");
	assert.match(ui.messages.at(-1)!.message, /authentication/);
});

test("applyExternalModelSetting survives a failing registry refresh", async () => {
	const ui = makeFakeUi();
	const ctx = makeContext({
		parent: new FakeParent(),
		manager: new FakeManager(),
		registry: makeRegistry([{ provider: "ok", id: "x" }], true),
		ui,
	});
	const ok = await applyExternalModelSetting(
		new FakeParent(),
		"parent",
		"ok/x",
		ctx,
		new FakeManager(),
		(message, type) => ui.notify(message, type),
	);
	assert.equal(ok, false);
	assert.match(ui.messages.at(-1)!.message, /Could not refresh/);
});

test("ModelConfigSync applies external create/update/delete and resets to the startup baseline", async () => {
	const dir = tempDir("sync");
	const path = join(dir, "models.json");
	mkdirSync(dir, { recursive: true });
	// The startup baseline is captured from the parent's active model, so the
	// initial active model must match the expected reset target (p/base).
	const parent = new FakeParent({ provider: "p", id: "base" });
	const manager = new FakeManager();
	const ui = makeFakeUi();
	const registry = makeRegistry([
		{ provider: "anthropic", id: "claude-sonnet-4-5" },
		{ provider: "p", id: "base" },
	]);
	const sync = new ModelConfigSync(parent, manager, { path, debounceMs: 10 });

	sync.start({ model: { ...parent.active }, modelRegistry: registry, ui });
	assert.equal(manager.applied.length, 0);

	// External create.
	writeFileSync(path, '{"worker":"external/one"}\n', "utf8");
	await sync.applyNow();
	assert.deepEqual(manager.applied, [["worker", "external/one"]]);

	// External update.
	writeFileSync(path, '{"worker":"external/two","reviewer":"external/reviewer"}\n', "utf8");
	await sync.applyNow();
	assert.ok(manager.applied.some(([target, model]) => target === "worker" && model === "external/two"));
	assert.ok(manager.applied.some(([target, model]) => target === "reviewer" && model === "external/reviewer"));

	// Parent update through the registry.
	writeFileSync(path, '{"parent":"anthropic/claude-sonnet-4-5"}\n', "utf8");
	await sync.applyNow();
	assert.deepEqual(parent.active, { provider: "anthropic", id: "claude-sonnet-4-5" });

	// External delete resets every role back to the startup baseline
	// (parent p/base, worker glm-5.2, reviewer kimi-k3).
	rmSync(path);
	await sync.applyNow();
	assert.deepEqual(parent.active, { provider: "p", id: "base" });
	assert.equal(manager.defaultModel, "opencode-go/glm-5.2");
	assert.equal(manager.profiles.reviewer, "opencode-go/kimi-k3");

	sync.close();
	rmSync(dir, { recursive: true, force: true });
});

test("ModelConfigSync treats corrupt config as absent and resets to baseline", async () => {
	const dir = tempDir("corrupt");
	const path = join(dir, "models.json");
	mkdirSync(dir, { recursive: true });
	const parent = new FakeParent();
	const manager = new FakeManager();
	manager.applied.push(["worker", "external/one"]);
	const ui = makeFakeUi();
	const sync = new ModelConfigSync(parent, manager, { path, debounceMs: 10 });
	const registry = makeRegistry([]);
	sync.start({ model: { provider: "p", id: "base" }, modelRegistry: registry, ui });

	writeFileSync(path, '{"worker":"external/one"}\n', "utf8");
	await sync.applyNow();

	writeFileSync(path, "{not json", "utf8");
	await sync.applyNow();
	assert.equal(manager.defaultModel, "opencode-go/glm-5.2");

	sync.close();
	rmSync(dir, { recursive: true, force: true });
});

test("ModelConfigSync captures the tester baseline and resets to it on delete", async () => {
	const dir = tempDir("tester-sync");
	const path = join(dir, "models.json");
	mkdirSync(dir, { recursive: true });
	const parent = new FakeParent({ provider: "p", id: "base" });
	const manager = new FakeManager();
	manager.testerProfile = "tester/baseline";
	const ui = makeFakeUi();
	const sync = new ModelConfigSync(parent, manager, { path, debounceMs: 10 });
	sync.start({ model: { ...parent.active }, modelRegistry: makeRegistry([]), ui });

	// External create applies to the running tester profile.
	writeFileSync(path, '{"tester":"external/tester"}\n', "utf8");
	await sync.applyNow();
	assert.equal(manager.testerProfile, "external/tester");

	// External delete resets tester back to the startup baseline.
	rmSync(path);
	await sync.applyNow();
	assert.equal(manager.testerProfile, "tester/baseline");

	sync.close();
	rmSync(dir, { recursive: true, force: true });
});

test("ModelConfigSync deduplicates in-session self-writes and retries failed parent changes", async () => {
	const dir = tempDir("dedupe");
	const path = join(dir, "models.json");
	mkdirSync(dir, { recursive: true });
	const parent = new FakeParent();
	const manager = new FakeManager();
	const ui = makeFakeUi();
	const registry = makeRegistry([{ provider: "anthropic", id: "claude-sonnet-4-5" }]);
	const sync = new ModelConfigSync(parent, manager, { path, debounceMs: 10 });
	sync.start({ model: { provider: "p", id: "base" }, modelRegistry: registry, ui });

	// In-session change (/orch-model): applied immediately and recorded so the
	// matching self-save is a watcher no-op.
	sync.noteInSessionApply("worker", "in-session/one");
	await sync.applyNow();
	assert.deepEqual(manager.applied, []);

	// External file now agrees with the applied state: still no re-application.
	writeFileSync(path, '{"worker":"in-session/one"}\n', "utf8");
	await sync.applyNow();
	assert.deepEqual(manager.applied, []);

	// Failed parent application leaves applied state unchanged; a later
	// reconcile retries once auth becomes available.
	parent.failNext = true;
	writeFileSync(path, '{"worker":"in-session/one","parent":"anthropic/claude-sonnet-4-5"}\n', "utf8");
	await sync.applyNow();
	assert.equal(parent.setModelCalls, 1);
	assert.notEqual(parent.active.provider, "anthropic");

	parent.failNext = false;
	await sync.applyNow();
	assert.equal(parent.setModelCalls, 2);
	assert.deepEqual(parent.active, { provider: "anthropic", id: "claude-sonnet-4-5" });

	// Reconciling again after success does not re-apply.
	await sync.applyNow();
	assert.equal(parent.setModelCalls, 2);

	sync.close();
	rmSync(dir, { recursive: true, force: true });
});

function pickerManager(model = "opencode:old/current") {
	return {
		configuration: () => ({
			binary: "opencode",
			model,
			profiles: { implementer: model, reviewer: model },
			testerProfile: model,
		}),
	} as unknown as OpenCodeTaskManager;
}

function pickerContext(options: {
	mode?: "tui" | "rpc";
	model?: { provider: string; id: string };
	scopedModels?: Array<{ model: { provider: string; id: string; name: string } }>;
	available?: Array<{ provider: string; id: string; name: string }>;
	select?: (title: string, items: string[]) => Promise<string | undefined>;
	input?: () => Promise<string | undefined>;
	custom?: <Result>(factory: Function) => Promise<Result>;
}) {
	const available = options.available ?? [];
	return {
		mode: options.mode ?? "tui",
		model: options.model,
		scopedModels: options.scopedModels ?? [],
		modelRegistry: {
			refresh: async () => {},
			getAvailable: () => available,
		},
		ui: {
			select: options.select ?? (async () => undefined),
			input: options.input ?? (async () => undefined),
			custom: options.custom,
			notify: () => {},
		},
		cwd: "/repo",
	} as unknown as ExtensionCommandContext;
}

test("chooseModel refreshes OpenCode discovery in the custom picker loop", async () => {
	let executions = 0;
	const pi = {
		exec: async () => {
			executions += 1;
			return { code: 0, stdout: executions === 1 ? "vendor/one\n" : "vendor/two\n", stderr: "" };
		},
	} as unknown as ExtensionAPI;
	const actions = [
		{ action: "refresh" },
		{ action: "select", value: "vendor/two" },
	];
	const ctx = pickerContext({
		select: async () => "OpenCode — use the OpenCode CLI (current)",
		custom: async <Result>(factory: Function) => {
			factory(
				{ requestRender() {} },
				{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
				{},
				() => {},
			);
			return actions.shift()! as Result;
		},
	});
	const selected = await chooseModel(pi, "worker", ctx, pickerManager());
	assert.equal(selected, "vendor/two");
	assert.equal(executions, 2);
});

test("chooseModel uses scoped Pi models and supports Ctrl+E custom entry action", async () => {
	let rendered = "";
	const ctx = pickerContext({
		model: { provider: "scope", id: "current" },
		scopedModels: [{ model: { provider: "scope", id: "only", name: "Scoped Only" } }],
		available: [{ provider: "global", id: "excluded", name: "Excluded" }],
		input: async () => "manual/model",
		custom: async <Result>(factory: Function) => {
			let answer: Result | undefined;
			const component = factory(
				{ requestRender() {} },
				{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
				{},
				(value: Result) => { answer = value; },
			);
			rendered = component.render(100).join("\n");
			component.handleInput(ctrlByte(Key.ctrl("e")));
			return answer!;
		},
	});
	const selected = await chooseModel({} as ExtensionAPI, "parent", ctx, pickerManager());
	assert.equal(selected, "manual/model");
	assert.match(rendered, /scope\/only/);
	assert.doesNotMatch(rendered, /global\/excluded/);
});

test("chooseModel parent discovery always uses Pi registry even when the current provider is named opencode", async () => {
	// The current Pi model's provider string ("opencode") must never redirect
	// the parent target to OpenCode CLI discovery or "opencode:" prefixing.
	let executions = 0;
	const pi = {
		exec: async () => {
			executions += 1;
			return { code: 0, stdout: "cli/only\n", stderr: "" };
		},
	} as unknown as ExtensionAPI;
	const ctx = pickerContext({
		mode: "rpc",
		model: { provider: "opencode", id: "glm-5.2" },
		available: [{ provider: "opencode", id: "from-registry", name: "From Registry" }],
		select: async (_title, items) => {
			const label = items.find((item) => item.endsWith("opencode/from-registry"));
			assert.ok(label);
			return label;
		},
	});
	const selected = await chooseModel(pi, "parent", ctx, pickerManager());
	// Registry value returned as-is: no CLI discovery, no "opencode:" prefix.
	assert.equal(selected, "opencode/from-registry");
	assert.equal(executions, 0);
});

test("chooseModel preserves select/input fallback outside TUI mode", async () => {
	const selections: string[][] = [];
	const ctx = pickerContext({
		mode: "rpc",
		model: { provider: "p", id: "current" },
		available: [{ provider: "p", id: "other", name: "Other" }],
		select: async (_title, items) => {
			selections.push(items);
			return "Enter a model ID manually...";
		},
		input: async () => "fallback/model",
	});
	const selected = await chooseModel({} as ExtensionAPI, "parent", ctx, pickerManager());
	assert.equal(selected, "fallback/model");
	assert.ok(selections[0]!.some((label) => label === "Current: p/current"));
});

test("orch-model target selection lists tester with its label", async () => {
	let command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> } | undefined;
	const pi = {
		registerCommand: (_name: string, definition: typeof command) => {
			command = definition;
		},
	} as unknown as ExtensionAPI;
	registerModelCommand(pi, {} as OpenCodeTaskManager);
	assert.ok(command);

	const labels: string[] = [];
	const ctx = pickerContext({
		mode: "rpc",
		select: async (_title, items) => {
			labels.push(...items);
			return undefined;
		},
	});
	await command!.handler("", ctx);
	assert.ok(labels.includes("tester — Tester profile"));
	assert.ok(labels.includes("implementer — Implementer profile"));
	assert.ok(labels.includes("reviewer — Reviewer profile"));
});

test("chooseModel tester discovery uses OpenCode CLI with prefix normalization", async () => {
	let executions = 0;
	const pi = {
		exec: async () => {
			executions += 1;
			return { code: 0, stdout: "vendor/one\n", stderr: "" };
		},
	} as unknown as ExtensionAPI;
	const actions = [{ action: "select", value: "vendor/one" }];
	const ctx = pickerContext({
		select: async () => "OpenCode — use the OpenCode CLI (current)",
		custom: async <Result>(factory: Function) => {
			factory(
				{ requestRender() {} },
				{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
				{},
				() => {},
			);
			return actions.shift()! as Result;
		},
	});
	// Tester resolves its configured opencode-prefixed value, lists through the
	// OpenCode CLI, and returns the canonical bare provider/model (the display
	// "opencode:" prefix never leaks into the stored model).
	const selected = await chooseModel(pi, "tester", ctx, pickerManager("opencode:old/current"));
	assert.equal(selected, "vendor/one");
	assert.equal(executions, 1);
});

test("chooseModel tester Pi backend uses scoped models and displays the current value", async () => {
	const selections: string[][] = [];
	const ctx = pickerContext({
		mode: "rpc",
		scopedModels: [{ model: { provider: "scope", id: "current", name: "Scoped Current" } }],
		available: [{ provider: "global", id: "excluded", name: "Excluded" }],
		select: async (_title, items) => {
			selections.push(items);
			if (items[0]?.startsWith("Pi —")) {
				return items.find((item) => item.startsWith("Pi —"))!;
			}
			const current = items.find((item) => item === "Current: scope/current");
			assert.ok(current, "tester current value must be marked Current in the picker");
			return current!;
		},
	});
	// Tester configured on the Pi backend discovers from scoped models (never
	// the global registry or OpenCode CLI) and shows the current value.
	const selected = await chooseModel({} as ExtensionAPI, "tester", ctx, pickerManager("pi::scope/current"));
	assert.equal(selected, "pi::scope/current");
	const modelLabels = selections.at(-1)!;
	assert.ok(modelLabels.some((label) => label === "Current: scope/current"));
	assert.ok(!modelLabels.some((label) => label.includes("global/excluded")));
});

test("ModelConfigSync.close stops reconciliation and releases the watcher", async () => {
	const dir = tempDir("close");
	const path = join(dir, "models.json");
	mkdirSync(dir, { recursive: true });
	const manager = new FakeManager();
	const ui = makeFakeUi();
	const sync = new ModelConfigSync(new FakeParent(), manager, { path, debounceMs: 10 });
	sync.start({ model: { provider: "p", id: "base" }, modelRegistry: makeRegistry([]), ui });
	sync.close();

	writeFileSync(path, '{"worker":"after/close"}\n', "utf8");
	await sync.applyNow();
	assert.deepEqual(manager.applied, []);
	assert.match(readFileSync(path, "utf8"), /after\/close/);

	// close() is safe to call twice.
	sync.close();
	assert.equal(existsSync(path), true);
	rmSync(dir, { recursive: true, force: true });
});

test("applyExternalModelSetting canonicalizes repeated opencode: prefixes before the manager", async () => {
	const ui = makeFakeUi();
	const manager = new FakeManager();
	const ctx = makeContext({ manager, ui });
	const ok = await applyExternalModelSetting(
		new FakeParent(),
		"implementer",
		"opencode:opencode:vendor/repeated",
		ctx,
		manager,
		(message, type) => ui.notify(message, type),
	);
	assert.equal(ok, true);
	// Only the bare provider/model reaches the manager, never the display prefix.
	assert.deepEqual(manager.applied, [["implementer", "vendor/repeated"]]);
	assert.equal(manager.profiles.implementer, "vendor/repeated");
	assert.match(ui.messages[0]!.message, /vendor\/repeated/);
});

test("ModelConfigSync live apply canonicalizes repeated opencode: prefixes for worker values", async () => {
	const dir = tempDir("repeated-prefix-sync");
	const path = join(dir, "models.json");
	mkdirSync(dir, { recursive: true });
	const parent = new FakeParent({ provider: "p", id: "base" });
	const manager = new FakeManager();
	const ui = makeFakeUi();
	const sync = new ModelConfigSync(parent, manager, { path, debounceMs: 10 });
	sync.start({ model: { ...parent.active }, modelRegistry: makeRegistry([]), ui });

	// External create with a repeated legacy prefix must apply as the bare value.
	writeFileSync(path, '{"worker":"opencode:opencode:ext/repeated"}\n', "utf8");
	await sync.applyNow();
	assert.deepEqual(manager.applied, [["worker", "ext/repeated"]]);
	assert.equal(manager.defaultModel, "ext/repeated");

	// A plain single-prefix external update canonicalizes the same way.
	writeFileSync(path, '{"worker":"opencode:ext/two"}\n', "utf8");
	await sync.applyNow();
	assert.equal(manager.defaultModel, "ext/two");

	// Pi worker values are preserved verbatim with their pi:: prefix.
	writeFileSync(path, '{"tester":"pi::scope/tester"}\n', "utf8");
	await sync.applyNow();
	assert.equal(manager.testerProfile, "pi::scope/tester");

	sync.close();
	rmSync(dir, { recursive: true, force: true });
});

test("chooseModel custom entry canonicalizes a repeated opencode: prefix to the bare model", async () => {
	let executions = 0;
	const pi = {
		exec: async () => {
			executions += 1;
			return { code: 0, stdout: "", stderr: "" };
		},
	} as unknown as ExtensionAPI;
	const selections: string[][] = [];
	const ctx = pickerContext({
		mode: "rpc",
		model: { provider: "p", id: "current" },
		available: [{ provider: "p", id: "other", name: "Other" }],
		select: async (_title, items) => {
			selections.push(items);
			// First call selects the OpenCode backend; second falls through to manual input.
			return items[0]?.startsWith("OpenCode —") ? items[0] : "Enter a model ID manually...";
		},
		input: async () => "opencode:opencode:vendor/custom",
	});
	// The manually entered value carries a repeated legacy prefix; the stored
	// result must be the canonical bare provider/model for OpenCode.
	const selected = await chooseModel(pi, "worker", ctx, pickerManager());
	assert.equal(selected, "vendor/custom");
	assert.equal(executions, 1);
});

test("chooseModel custom entry keeps the pi:: prefix for the Pi backend", async () => {
	const selections: string[][] = [];
	const ctx = pickerContext({
		mode: "rpc",
		model: { provider: "p", id: "current" },
		available: [{ provider: "p", id: "other", name: "Other" }],
		select: async (_title, items) => {
			selections.push(items);
			// First call selects the Pi backend; second falls through to manual input.
			return items[0]?.startsWith("Pi —") ? items[0] : "Enter a model ID manually...";
		},
		input: async () => "pi::scope/manual",
	});
	// Pi backend custom entries keep the pi:: backend marker for identification.
	const selected = await chooseModel({} as ExtensionAPI, "worker", ctx, pickerManager());
	assert.equal(selected, "pi::scope/manual");
});
