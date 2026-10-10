import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, parseKey, visibleWidth } from "@earendil-works/pi-tui";
import {
	modelPickerItems,
	showModelPicker,
	type ModelPickerEntry,
	type ModelPickerResult,
} from "./model-picker.ts";

const entries: ModelPickerEntry[] = [
	{
		value: "anthropic/claude-sonnet",
		provider: "anthropic",
		modelId: "claude-sonnet",
		displayName: "Claude Sonnet",
		backend: "pi",
		current: true,
	},
	{
		value: "opencode-go/glm",
		provider: "opencode-go",
		modelId: "glm",
		backend: "opencode",
	},
];

test("modelPickerItems marks the current model and describes display name/backend", () => {
	const items = modelPickerItems(entries);
	assert.match(items[0]!.label, /^● anthropic\/claude-sonnet$/);
	assert.equal(items[0]!.description, "current · Claude Sonnet · Pi");
	assert.equal(items[1]!.description, "OpenCode CLI");
});

// The picker component's handleInput consumes raw terminal bytes, not pi-tui
// Key ID strings. Derive the exact legacy control bytes from the same public
// Key.ctrl(...) identifiers the implementation binds (Ctrl+E custom entry,
// Ctrl+R refresh), so the focused tests always send/assert the advertised
// shortcuts instead of magic constants.
function ctrlByte(keyId: `ctrl+${string}`) {
	const letter = keyId.slice("ctrl+".length);
	return String.fromCharCode(letter.charCodeAt(0) - 96);
}

const CTRL_E = ctrlByte(Key.ctrl("e"));
const CTRL_U = ctrlByte(Key.ctrl("u"));
const CTRL_R = ctrlByte(Key.ctrl("r"));
const ESCAPE = "\u001b";
const ENTER = "\r";

test("focused Ctrl+E/Ctrl+U bytes agree with the public Key API", () => {
	assert.equal(parseKey(CTRL_E), Key.ctrl("e"));
	assert.equal(parseKey(CTRL_U), Key.ctrl("u"));
	assert.equal(parseKey(CTRL_R), Key.ctrl("r"));
	// Ctrl+E must match the custom-entry binding; Ctrl+U must not.
	assert.equal(matchesKey(CTRL_E, Key.ctrl("e")), true);
	assert.equal(matchesKey(CTRL_U, Key.ctrl("e")), false);
});

async function drivePicker(input: string, width = 42, choices = entries, mode = "tui") {
	let component: {
		render(width: number): string[];
		invalidate(): void;
		handleInput(data: string): void;
	} | undefined;
	let renders = 0;
	let customOptions: any;
	const ctx = {
		mode,
		ui: {
			custom<Result>(factory: Function, options: any): Promise<Result> {
				customOptions = options;
				return new Promise<Result>((resolve) => {
					component = factory(
						{ requestRender: () => { renders += 1; } },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						{},
						resolve,
					);
				});
			},
		},
	} as unknown as ExtensionCommandContext;
	const pending = showModelPicker(ctx, "Choose model", choices);
	assert.ok(component);
	const lines = component.render(width);
	component.handleInput(input);
	return { pending, lines, renders, component, customOptions };
}

test("custom picker renders title/help/current marker within the supplied width", { timeout: 5_000 }, async () => {
	const driven = await drivePicker(CTRL_E, 30);
	assert.deepEqual(await driven.pending, { action: "custom" });
	assert.ok(driven.lines.some((line) => line.includes("Choose model")));
	assert.ok(driven.lines.some((line) => line.includes("● anthropic")));
	// The advertised custom-entry shortcut must literally contain the public
	// Ctrl+E identifier so it cannot disagree with the handler.
	assert.ok(driven.lines.some((line) => line.includes(Key.ctrl("e"))));
	assert.ok(driven.lines.every((line) => visibleWidth(line) <= 30));
	assert.equal(driven.renders, 1);
	driven.component.invalidate();
});

test("custom picker returns refresh and cancellation actions", { timeout: 5_000 }, async () => {
	const refresh = await drivePicker(CTRL_R);
	assert.deepEqual(await refresh.pending, { action: "refresh" });
	const cancel = await drivePicker(ESCAPE);
	assert.deepEqual(await cancel.pending, { action: "cancel" });
});

test("custom picker returns the selected model on Enter", { timeout: 5_000 }, async () => {
	const driven = await drivePicker(ENTER);
	const result: ModelPickerResult = await driven.pending;
	assert.deepEqual(result, { action: "select", value: "anthropic/claude-sonnet" });
});

test("custom picker does not trigger custom entry on Ctrl+U", { timeout: 5_000 }, async () => {
	const driven = await drivePicker(CTRL_U);
	// Ctrl+U is not bound to any picker action, so the component stays open
	// instead of resolving with the custom-entry action.
	const settled = await Promise.race([
		driven.pending.then(() => "settled" as const),
		new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
	]);
	assert.equal(settled, "pending");
});
const manyModels: ModelPickerEntry[] = Array.from({length: 35}, (_, index) => ({
 value: `provider/model-${index}`, provider: "provider", modelId: `model-${index}`, backend: "pi", current: index === 0,
}));

test("long model lists scroll beyond the first screen with arrows and paging", async () => {
 const driven = await drivePicker("", 50, manyModels);
 for (let index = 0; index < 12; index++) driven.component.handleInput("\x1b[B");
 let lines = driven.component.render(50);
 assert.ok(lines.some(line => line.includes("> ● ") || line.includes(">   provider/model-12")));
 assert.ok(!lines.some(line => line.endsWith("provider/model-0")));
 driven.component.handleInput("\x1b[6~");
 lines = driven.component.render(50);
 assert.ok(lines.some(line => line.includes("23/35")));
 driven.component.handleInput("\x1b[5~");
 driven.component.handleInput(ENTER);
 assert.deepEqual(await driven.pending, {action: "select", value: "provider/model-12"});
});

test("OMP picker enables fullscreen wheel input and keeps scrolling bounded", async () => {
 const driven = await drivePicker("", 50, manyModels, "omp");
 assert.equal(driven.customOptions.overlay, true);
 assert.equal(driven.customOptions.overlayOptions.fullscreen, true);
 driven.component.handleInput("\x1b[<65;10;5M");
 assert.ok(driven.component.render(50).some(line => line.includes("4/35")));
 driven.component.handleInput("\x1b[<64;10;5M");
 assert.ok(driven.component.render(50).some(line => line.includes("1/35")));
 for (let i=0; i<20; i++) driven.component.handleInput("\x1b[<81;10;5M");
 assert.ok(driven.component.render(50).some(line => line.includes("35/35")));
 driven.component.handleInput(ENTER);
 assert.deepEqual(await driven.pending, {action: "select", value: "provider/model-34"});
});

test("filtering a scrolled model list resets the viewport and selects the filtered model", async () => {
 const driven = await drivePicker("\x1b[F", 50, manyModels);
 driven.component.render(50);
 driven.component.handleInput("model-23");
 const lines = driven.component.render(50);
 assert.ok(lines.some(line => line.includes("1/1")));
 assert.ok(lines.some(line => line.includes("provider/model-23")));
 driven.component.handleInput(ENTER);
 assert.deepEqual(await driven.pending, {action: "select", value: "provider/model-23"});
});
