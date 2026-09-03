import { DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";

export interface ModelPickerEntry {
	value: string;
	provider: string;
	modelId: string;
	displayName?: string;
	backend: "pi" | "opencode";
	current?: boolean;
}

export type ModelPickerResult =
	| { action: "select"; value: string }
	| { action: "refresh" }
	| { action: "custom" }
	| { action: "cancel" };

// The advertised help text and the actual handler share these public key
// identifiers (Key.ctrl from @earendil-works/pi-tui) so the custom-entry and
// refresh shortcuts cannot drift apart. Ctrl+E opens custom ID entry; Ctrl+R
// refreshes the model list; other keys fall through to the SelectList.
const REFRESH_KEY = Key.ctrl("r");
const CUSTOM_KEY = Key.ctrl("e");

/** Build SelectList rows without baking in terminal styling. */
export function modelPickerItems(entries: readonly ModelPickerEntry[]): SelectItem[] {
	return entries.map((entry) => {
		const backend = entry.backend === "pi" ? "Pi" : "OpenCode CLI";
		const details = entry.displayName && entry.displayName !== entry.modelId
			? `${entry.displayName} · ${backend}`
			: backend;
		return {
			value: entry.value,
			label: `${entry.current ? "● " : "  "}${entry.provider}/${entry.modelId}`,
			description: entry.current ? `current · ${details}` : details,
		};
	});
}

/**
 * Show the searchable TUI picker. Callers must guard this with `ctx.mode ===
 * "tui"`; keeping the guard outside makes RPC/print fallbacks explicit.
 */
export async function showModelPicker(
	ctx: ExtensionCommandContext,
	title: string,
	entries: readonly ModelPickerEntry[],
): Promise<ModelPickerResult> {
	const items = modelPickerItems(entries);
	return await ctx.ui.custom((tui: { requestRender(): void }, theme: {
		fg(color: "accent" | "muted" | "dim" | "warning", text: string): string;
		bold(text: string): string;
	}, _keybindings: unknown, done: (result: ModelPickerResult) => void) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(new Text(theme.fg("dim", "Type to search models"), 1, 0));

		const selectList = new SelectList(items, Math.max(1, Math.min(items.length, 10)), {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		});
		selectList.onSelect = (item: SelectItem) => done({ action: "select", value: item.value });
		selectList.onCancel = () => done({ action: "cancel" });
		container.addChild(selectList);

		container.addChild(new Text(
			theme.fg("dim", `↑↓ navigate • enter select • esc cancel • ${REFRESH_KEY} refresh • ${CUSTOM_KEY} custom ID`),
			1,
			0,
		));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render(width: number) {
				const safeWidth = Math.max(0, width);
				return container.render(safeWidth).map((line: string) => truncateToWidth(line, safeWidth, ""));
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, REFRESH_KEY)) done({ action: "refresh" });
				else if (matchesKey(data, CUSTOM_KEY)) done({ action: "custom" });
				else selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
