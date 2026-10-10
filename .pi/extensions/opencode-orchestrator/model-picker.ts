import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	type SelectItem,
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
// refreshes the model list. Navigation keeps selection inside a bounded viewport.
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
 * Show the portable searchable picker in Pi or OMP TUI mode. OMP uses a
 * fullscreen overlay so wheel input reaches the component instead of scrollback.
 */
export async function showModelPicker(
	ctx: ExtensionCommandContext,
	title: string,
	entries: readonly ModelPickerEntry[],
): Promise<ModelPickerResult> {
	const items = modelPickerItems(entries);
	return await ctx.ui.custom((tui: { requestRender(): void; terminal?: { rows?: number } }, theme: {
		fg(color: "accent" | "muted" | "dim" | "warning", text: string): string;
		bold(text: string): string;
	}, _keybindings: unknown, done: (result: ModelPickerResult) => void) => {
		let query = "";
		let filtered = items;
		let selected = Math.max(0, items.findIndex(item => item.value === entries.find(entry => entry.current)?.value));
		let offset = 0;
		const pageSize = () => Math.max(1, Math.min(10, (tui.terminal?.rows ?? process.stdout.rows ?? 24) - 7));
		const scroll = (delta: number) => {
			selected = Math.max(0, Math.min(filtered.length - 1, selected + delta));
		};
		const filter = () => {
			const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
			filtered = items.filter(item => terms.every(term => `${item.label} ${item.description ?? ""}`.toLowerCase().includes(term)));
			selected = 0;
			offset = 0;
		};
		return {
			render(width: number) {
				const safeWidth = Math.max(0, width);
				const size = pageSize();
				offset = Math.max(0, Math.min(offset, Math.max(0, filtered.length - size)));
				if (selected < offset) offset = selected;
				if (selected >= offset + size) offset = selected - size + 1;
				const lines = [
					theme.fg("accent", theme.bold(title)),
					theme.fg("dim", `Search: ${query || "type to filter"}`),
					...filtered.slice(offset, offset + size).map((item, index) =>
						theme.fg(offset + index === selected ? "accent" : "muted", `${offset + index === selected ? "> " : "  "}${item.label}`)),
					...(filtered.length ? [theme.fg("dim", `${selected + 1}/${filtered.length} models`)] : [theme.fg("warning", "No matching models")]),
					theme.fg("dim", "↑↓ / PgUp PgDn / wheel"),
					theme.fg("dim", "enter select • esc cancel"),
					theme.fg("dim", `${REFRESH_KEY} refresh • ${CUSTOM_KEY} ID`),
				];
				return lines.map(line => truncateToWidth(line, safeWidth, ""));
			},
			invalidate() {},
			handleInput(data: string) {
				// SGR and legacy X10 wheel packets, including modifier bits.
				const mouse = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
				const button = mouse ? Number(mouse[1]) : data.startsWith("\x1b[M") && data.length >= 6 ? data.charCodeAt(3) - 32 : undefined;
				if (button !== undefined) {
					if ((button & 64) !== 0) scroll((button & 1) === 0 ? -3 : 3);
				} else if (matchesKey(data, REFRESH_KEY)) done({ action: "refresh" });
				else if (matchesKey(data, CUSTOM_KEY)) done({ action: "custom" });
				else if (matchesKey(data, Key.escape)) done({ action: "cancel" });
				else if (matchesKey(data, Key.enter)) {
					if (filtered[selected]) done({ action: "select", value: filtered[selected]!.value });
				} else if (matchesKey(data, Key.up)) scroll(-1);
				else if (matchesKey(data, Key.down)) scroll(1);
				else if (matchesKey(data, Key.pageUp)) scroll(-pageSize());
				else if (matchesKey(data, Key.pageDown)) scroll(pageSize());
				else if (matchesKey(data, Key.home)) selected = 0;
				else if (matchesKey(data, Key.end)) selected = Math.max(0, filtered.length - 1);
				else if (matchesKey(data, Key.backspace)) { query = Array.from(query).slice(0, -1).join(""); filter(); }
				else if (matchesKey(data, Key.ctrl("u"))) { query = ""; filter(); }
				else if (data && !/[\x00-\x1f\x7f-\x9f]/.test(data)) { query += data; filter(); }
				tui.requestRender();
			},
		};
	}, (ctx.mode as string) === "omp" ? { overlay: true, overlayOptions: { fullscreen: true } } as any : undefined);
}
