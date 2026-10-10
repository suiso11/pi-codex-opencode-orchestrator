import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { OpenCodeTaskManager } from "./manager.ts";
import {
	showModelPicker,
	type ModelPickerEntry,
} from "./model-picker.ts";
import {
	decodeWorkerModel,
	encodeWorkerModel,
	normalizeWorkerModelValue,
	type ModelProfile,
	type WorkerBackend,
} from "./types.ts";
import {
	effectiveModelSetting,
	loadSavedModelSettings,
	MODEL_SETTING_DEFINITIONS,
	modelConfigPath,
	resetSavedModelSetting,
	saveModelSetting,
	watchModelConfig,
	type ModelConfigWatcher,
	type ModelSettingName,
	type SavedModelSettings,
} from "./model-config.ts";

const TARGETS = Object.keys(MODEL_SETTING_DEFINITIONS) as ModelSettingName[];
const MANUAL_ENTRY = "Enter a model ID manually...";
const OPENCODE_MODEL_PREFIX = "opencode:";

function loadedFromSavedConfig(name: ModelSettingName) {
	return (process.env.PI_ORCH_SAVED_SETTINGS ?? "").split(",").includes(name);
}

function splitProviderModel(value: string) {
	const normalized = value.trim();
	const slash = normalized.indexOf("/");
	if (slash <= 0 || slash === normalized.length - 1 || /[\s\0]/.test(normalized)) return undefined;
	return { provider: normalized.slice(0, slash), modelId: normalized.slice(slash + 1), value: normalized };
}

function stripAnsi(value: string) {
	return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function parseOpenCodeModels(output: string) {
	return stripAnsi(output)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => splitProviderModel(line) !== undefined);
}

function withOpenCodePrefix(value: string) {
	return value.startsWith(OPENCODE_MODEL_PREFIX) ? value : `${OPENCODE_MODEL_PREFIX}${value}`;
}

function currentModel(name: ModelSettingName, ctx: ExtensionCommandContext, tasks: OpenCodeTaskManager) {
	if (name === "parent") {
		return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : effectiveModelSetting(name);
	}
	const config = tasks.configuration();
	if (name === "worker") return config.model;
	if (name === "implementer") return config.profiles.implementer;
	if (name === "tester") return config.testerProfile;
	return config.profiles.reviewer;
}

async function availableModels(
	pi: ExtensionAPI,
	backend: WorkerBackend | "parent",
	ctx: ExtensionCommandContext,
	tasks: OpenCodeTaskManager,
): Promise<ModelPickerEntry[]> {
	if (backend === "parent" || backend === "pi") {
		await ctx.modelRegistry.refresh();
		const models = ctx.scopedModels.length > 0
			? ctx.scopedModels.map((entry) => entry.model)
			: ctx.modelRegistry.getAvailable();
		return models.map((model) => ({
			value: `${model.provider}/${model.id}`,
			provider: model.provider,
			modelId: model.id,
			displayName: model.name,
			backend: "pi",
		}));
	}
	const binary = tasks.configuration().binary;
	const result = await pi.exec(binary, ["models"], { cwd: ctx.cwd, timeout: 30_000 });
	if (result.code !== 0) {
		ctx.ui.notify(`Could not list OpenCode models: ${result.stderr.trim() || `exit ${result.code}`}`, "warning");
		return [];
	}
	return parseOpenCodeModels(result.stdout).map((value) => {
		// Keep discovered OpenCode models in the same "opencode:"-prefixed form
		// as the configured current model (which decodeWorkerModel passes through
		// verbatim), so a Ctrl+R refresh round-trips the backend prefix exactly
		// like the initial discovery. Never double-prefix, and never touch the
		// Pi backend entries.
		const prefixed = withOpenCodePrefix(value);
		const raw = value.startsWith(OPENCODE_MODEL_PREFIX) ? value.slice(OPENCODE_MODEL_PREFIX.length) : value;
		const parsed = splitProviderModel(raw)!;
		return {
			value: prefixed,
			provider: parsed.provider,
			modelId: parsed.modelId,
			backend: "opencode" as const,
		};
	});
}

async function chooseTarget(ctx: ExtensionCommandContext) {
	const labels = TARGETS.map((name) => `${name} — ${MODEL_SETTING_DEFINITIONS[name].label}`);
	const selected = await ctx.ui.select("Which model do you want to change?", labels);
	return selected?.split(" — ", 1)[0] as ModelSettingName | undefined;
}

export async function chooseModel(
	pi: ExtensionAPI,
	name: ModelSettingName,
	ctx: ExtensionCommandContext,
	tasks: OpenCodeTaskManager,
) {
	const configured = currentModel(name, ctx, tasks);
	let backend: WorkerBackend | "parent" = "parent";
	let current = configured;
	if (name !== "parent") {
		const selection = decodeWorkerModel(configured);
		current = selection.model;
		const backendOptions = [
			`Pi — use Pi providers directly${selection.backend === "pi" ? " (current)" : ""}`,
			`OpenCode — use the OpenCode CLI${selection.backend === "opencode" ? " (current)" : ""}`,
		];
		const selectedBackend = await ctx.ui.select("Worker backend", backendOptions);
		if (!selectedBackend) return undefined;
		backend = selectedBackend.startsWith("Pi —") ? "pi" : "opencode";
	}
	const currentForBackend = name === "parent" || decodeWorkerModel(configured).backend === backend ? current : undefined;
	while (true) {
		const discovered = await availableModels(pi, backend, ctx, tasks);
		const byValue = new Map(discovered.map((entry) => [entry.value, entry]));
		if (currentForBackend && !byValue.has(currentForBackend)) {
			const parsed = splitProviderModel(currentForBackend);
			if (parsed) {
				byValue.set(currentForBackend, {
					value: currentForBackend,
					provider: parsed.provider,
					modelId: parsed.modelId,
					backend: backend === "opencode" ? "opencode" : "pi",
				});
			}
		}
		const entries = [...byValue.values()]
			.map((entry) => ({ ...entry, current: entry.value === currentForBackend }))
			.sort((left, right) => {
				if (left.current) return -1;
				if (right.current) return 1;
				return left.value.localeCompare(right.value);
			});

		let chosen: string | undefined;
		if ((ctx.mode === "tui" || (ctx.mode as string) === "omp") && typeof ctx.ui.custom === "function") {
			const result = await showModelPicker(ctx, `${MODEL_SETTING_DEFINITIONS[name].label} model`, entries);
			if (result.action === "cancel") return undefined;
			if (result.action === "refresh") continue;
			if (result.action === "custom") {
				chosen = await ctx.ui.input("Provider/model ID", currentForBackend ?? "provider/model");
			} else {
				chosen = backend === "opencode" ? withOpenCodePrefix(result.value) : result.value;
			}
		} else {
			const labels = [
				...entries.map((entry) => entry.current ? `Current: ${entry.value}` : entry.value),
				MANUAL_ENTRY,
			];
			const selected = await ctx.ui.select(`${MODEL_SETTING_DEFINITIONS[name].label} model`, labels);
			if (!selected) return undefined;
			chosen = selected === MANUAL_ENTRY
				? await ctx.ui.input("Provider/model ID", currentForBackend ?? "provider/model")
				: backend === "opencode"
					? withOpenCodePrefix(selected.startsWith("Current: ") ? selected.slice("Current: ".length) : selected)
					: selected.startsWith("Current: ") ? selected.slice("Current: ".length) : selected;
		}
		if (!chosen) return undefined;
		return name === "parent" ? chosen : encodeWorkerModel(backend as WorkerBackend, chosen);
	}
}

async function activateModel(
	pi: ExtensionAPI,
	name: ModelSettingName,
	value: string,
	ctx: ExtensionCommandContext,
	tasks: OpenCodeTaskManager,
) {
	const selection = name === "parent" ? undefined : decodeWorkerModel(value);
	const parsed = splitProviderModel(selection?.model ?? value);
	if (!parsed) {
		ctx.ui.notify("Use a provider/model ID such as anthropic/claude-sonnet-4-5.", "error");
		return false;
	}

	if (name === "parent") {
		await ctx.modelRegistry.refresh();
		const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
		if (!model) {
			ctx.ui.notify(`Parent model is not available: ${parsed.value}. Authenticate its provider with /login first.`, "error");
			return false;
		}
		if (!await pi.setModel(model)) {
			ctx.ui.notify(`No usable authentication for ${parsed.value}.`, "error");
			return false;
		}
	} else {
		tasks.setModelSetting(name, encodeWorkerModel(selection!.backend, parsed.value));
	}
	return true;
}

/**
 * Minimal structural shapes consumed by the live model config sync so tests
 * can inject fake Pi/context/manager objects without a full agent runtime.
 */
export interface ModelConfigPiLike {
	setModel(model: { provider: string; id: string }): Promise<boolean>;
}

export interface ModelConfigContextLike {
	model?: { provider: string; id: string } | undefined;
	modelRegistry: {
		refresh(): Promise<unknown>;
		find(provider: string, modelId: string): { provider: string; id: string } | undefined;
	};
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
}

export interface ModelConfigManagerLike {
	configuration(): { model: string; profiles: Record<ModelProfile, string>; testerProfile: string };
	setModelSetting(target: "worker" | ModelProfile | "tester", model: string): void;
}

/**
 * Apply one persisted setting to the running process without touching
 * process.env. Worker/profile changes affect future tasks only. A parent
 * model that is unavailable or unauthenticated retains the current model,
 * reports a warning, and returns false so the caller can leave the applied
 * state unchanged and retry on the next file event.
 */
export async function applyExternalModelSetting(
	pi: ModelConfigPiLike,
	name: ModelSettingName,
	value: string,
	ctx: ModelConfigContextLike,
	manager: ModelConfigManagerLike,
	notify: (message: string, type: "info" | "warning") => void,
): Promise<boolean> {
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (name === "parent") {
		const parsed = splitProviderModel(trimmed);
		if (!parsed) {
			notify(`models.json contains an invalid parent model: ${trimmed}`, "warning");
			return false;
		}
		try {
			await ctx.modelRegistry.refresh();
		} catch {
			notify(`Could not refresh models to apply ${parsed.value}; keeping the current parent model.`, "warning");
			return false;
		}
		const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
		if (!model) {
			notify(`Parent model ${parsed.value} is not available; keeping the current parent model.`, "warning");
			return false;
		}
		let applied = false;
		try {
			applied = await pi.setModel(model);
		} catch {
			applied = false;
		}
		if (!applied) {
			notify(`No usable authentication for ${parsed.value}; keeping the current parent model.`, "warning");
			return false;
		}
		notify(`Parent model updated to ${parsed.value} (models.json).`, "info");
		return true;
	}
	if (/[\s\0]/.test(trimmed)) {
		notify(`models.json contains an invalid ${name} model: ${trimmed}`, "warning");
		return false;
	}
	// Non-parent (worker/profile) values must be canonicalized before they
	// reach the manager: strip any stray legacy "opencode:" prefix(es) so the
	// running process, persistence, and task snapshots never carry the display
	// prefix, while preserving "pi::provider/model" values verbatim.
	const normalized = normalizeWorkerModelValue(trimmed);
	if (!normalized) {
		notify(`models.json contains an invalid ${name} model: ${trimmed}`, "warning");
		return false;
	}
	manager.setModelSetting(name, normalized);
	notify(`${MODEL_SETTING_DEFINITIONS[name].label} updated to ${normalized} (models.json).`, "info");
	return true;
}

export interface ModelConfigSyncOptions {
	/** models.json path to watch and read (defaults to the platform config path). */
	path?: string;
	/** Debounce window for the file watcher. */
	debounceMs?: number;
}

/**
 * Live model config sync. Tracks one startup baseline per session plus the
 * values currently applied to the running process, and reconciles both with
 * the persisted models.json whenever the file changes.
 *
 * - Create/update/delete/rename by the external `pi-orch model` command is
 *   applied without a process restart.
 * - A missing key or a deleted config resets that role to its startup-resolved
 *   baseline captured once when the session starts.
 * - Explicit in-session changes (/orch-model) are authoritative over the
 *   inherited startup environment and update the baseline, so a later
 *   external reset reverts to them.
 * - Self-generated /orch-model saves are deduplicated: the save already
 *   applies immediately, and the matching file event is a no-op because the
 *   applied map already holds that value.
 */
export class ModelConfigSync {
	private readonly pi: ModelConfigPiLike;
	private readonly manager: ModelConfigManagerLike;
	private readonly options: ModelConfigSyncOptions;
	private baseline: Partial<Record<ModelSettingName, string>> = {};
	private applied: Partial<Record<ModelSettingName, string>> = {};
	private watcher: ModelConfigWatcher | undefined;
	private ctx: ModelConfigContextLike | undefined;
	private closed = true;

	constructor(pi: ModelConfigPiLike, manager: ModelConfigManagerLike, options: ModelConfigSyncOptions = {}) {
		this.pi = pi;
		this.manager = manager;
		this.options = options;
	}

	/** Capture the session-start baseline and start watching models.json. */
	start(ctx: ModelConfigContextLike) {
		this.ctx = ctx;
		this.closed = false;
		this.captureBaseline(ctx);
		this.applied = { ...this.baseline };
		this.watcher?.close();
		this.watcher = watchModelConfig(() => {
			void this.applyNow();
		}, {
			path: this.options.path,
			debounceMs: this.options.debounceMs,
		});
	}

	/**
	 * Record an explicit in-session apply (from /orch-model) so the matching
	 * self-write is not re-applied by the watcher and becomes the reset
	 * baseline for the rest of the running process.
	 */
	noteInSessionApply(name: ModelSettingName, value: string) {
		this.baseline[name] = value;
		this.applied[name] = value;
	}

	/** Stop the watcher during session shutdown/reload. */
	close() {
		this.closed = true;
		this.watcher?.close();
		this.watcher = undefined;
		this.ctx = undefined;
	}

	/**
	 * Read the persisted config and apply any differences. Public so tests can
	 * reconcile deterministically without waiting on fs events.
	 */
	async applyNow() {
		if (this.closed || !this.ctx) return;
		let saved: SavedModelSettings;
		try {
			saved = loadSavedModelSettings(this.options.path ?? modelConfigPath());
		} catch {
			// Unreadable or corrupt config counts as absent: reset to baseline.
			saved = {};
		}
		const ctx = this.ctx;
		const notify = (message: string, type: "info" | "warning") => {
			try {
				ctx.ui.notify(message, type);
			} catch {
				// UI can be unavailable during shutdown; ignore.
			}
		};
		for (const name of TARGETS) {
			if (this.closed) return;
			const raw = saved[name];
			const value = raw && raw.trim() ? raw.trim() : this.baseline[name];
			if (value === undefined) continue;
			if (value === this.applied[name]) continue;
			const ok = await applyExternalModelSetting(this.pi, name, value, ctx, this.manager, notify);
			if (this.closed) return;
			if (ok) this.applied[name] = value;
			// On failure the current value is retained and the applied map is
			// left unchanged so the next file event retries the change.
		}
	}

	private captureBaseline(ctx: ModelConfigContextLike) {
		const config = this.manager.configuration();
		this.baseline = {
			parent: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : effectiveModelSetting("parent"),
			worker: config.model,
			implementer: config.profiles.implementer,
			reviewer: config.profiles.reviewer,
			tester: config.testerProfile,
		};
	}
}

function showSettings(ctx: ExtensionCommandContext, tasks: OpenCodeTaskManager) {
	let saved;
	try {
		saved = loadSavedModelSettings();
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}
	const lines = TARGETS.map((name) => {
		const configured = currentModel(name, ctx, tasks);
		const active = name === "parent"
			? configured
			: (() => {
				const selection = decodeWorkerModel(configured);
				return `${selection.backend} -> ${selection.model}`;
			})();
		const source = loadedFromSavedConfig(name)
			? "saved"
			: process.env[MODEL_SETTING_DEFINITIONS[name].env]
			? MODEL_SETTING_DEFINITIONS[name].env
			: saved[name] ? "saved" : "default";
		return `${name}: ${active} (${source})`;
	});
	ctx.ui.notify(`${lines.join("\n")}\nConfig: ${modelConfigPath()}`, "info");
}

async function setAndSave(
	pi: ExtensionAPI,
	name: ModelSettingName,
	value: string,
	ctx: ExtensionCommandContext,
	tasks: OpenCodeTaskManager,
	sync?: ModelConfigSync,
) {
	if (!await activateModel(pi, name, value, ctx, tasks)) return;
	sync?.noteInSessionApply(name, value);
	try {
		saveModelSetting(name, value);
		const envOverride = !loadedFromSavedConfig(name) && process.env[MODEL_SETTING_DEFINITIONS[name].env];
		const note = envOverride ? ` ${MODEL_SETTING_DEFINITIONS[name].env} will override it after restart.` : "";
		const displayValue = name === "parent"
			? value
			: (() => {
				const selection = decodeWorkerModel(value);
				return `${selection.backend} -> ${selection.model}`;
			})();
		ctx.ui.notify(`Saved ${name}: ${displayValue}.${note}`, envOverride ? "warning" : "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

async function resetSetting(
	pi: ExtensionAPI,
	name: ModelSettingName | undefined,
	ctx: ExtensionCommandContext,
	tasks: OpenCodeTaskManager,
	sync?: ModelConfigSync,
) {
	const targets = name ? [name] : TARGETS;
	for (const target of targets) {
		const defaultValue = MODEL_SETTING_DEFINITIONS[target].defaultValue;
		if (!await activateModel(pi, target, defaultValue, ctx, tasks)) return;
		sync?.noteInSessionApply(target, defaultValue);
	}
	resetSavedModelSetting(name);
	ctx.ui.notify(name ? `Reset ${name} to its default.` : "Reset all orchestrator models to their defaults.", "info");
}

export function registerModelCommand(pi: ExtensionAPI, tasks: OpenCodeTaskManager, sync?: ModelConfigSync) {
	pi.registerCommand("orch-model", {
		description: "Choose worker backends and models, including direct Pi/Claude workers",
		getArgumentCompletions: (prefix) => {
			if (prefix.includes(" ")) return null;
			return ["show", "reset", ...TARGETS]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const value = args.trim();
			if (value === "show") {
				showSettings(ctx, tasks);
				return;
			}
			if (value === "reset" || value.startsWith("reset ")) {
				const target = value.split(/\s+/, 2)[1] as ModelSettingName | undefined;
				if (target && !TARGETS.includes(target)) {
					ctx.ui.notify(`Unknown target: ${target}`, "error");
					return;
				}
				await resetSetting(pi, target, ctx, tasks, sync);
				return;
			}

			if (value) {
				const [targetValue, ...modelParts] = value.split(/\s+/);
				const target = targetValue as ModelSettingName;
				if (!TARGETS.includes(target) || modelParts.length === 0) {
					ctx.ui.notify("Usage: /orch-model <target> [pi|opencode] provider/model", "error");
					return;
				}
				let modelValue = modelParts.join(" ");
				if (target !== "parent" && (modelParts[0] === "pi" || modelParts[0] === "opencode")) {
					if (modelParts.length < 2) {
						ctx.ui.notify("Provide a provider/model after the worker backend.", "error");
						return;
					}
					modelValue = encodeWorkerModel(modelParts[0], modelParts.slice(1).join(" "));
				}
				await setAndSave(pi, target, modelValue, ctx, tasks, sync);
				return;
			}

			const target = await chooseTarget(ctx);
			if (!target) return;
			const model = await chooseModel(pi, target, ctx, tasks);
			if (!model) return;
			await setAndSave(pi, target, model, ctx, tasks, sync);
		},
	});
}
