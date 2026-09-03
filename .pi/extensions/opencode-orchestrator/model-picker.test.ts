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

async function drivePicker(input: string, width = 42) {
	let component: {
		render(width: number): string[];
		invalidate(): void;
		handleInput(data: string): void;
	} | undefined;
	let renders = 0;
	const ctx = {
		ui: {
			custom<Result>(factory: Function): Promise<Result> {
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
	const pending = showModelPicker(ctx, "Choose model", entries);
	assert.ok(component);
	const lines = component.render(width);
	component.handleInput(input);
	return { pending, lines, renders, component };
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

test("custom picker delegates Enter to SelectList selection", { timeout: 5_000 }, async () => {
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