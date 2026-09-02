import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	watch as watchFile,
	writeFileSync,
	type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_MODEL, MODEL_PROFILE_DEFAULTS, normalizeWorkerModelValue } from "./types.ts";

export const MODEL_SETTING_DEFINITIONS = {
	parent: {
		env: "PI_CODEX_MODEL",
		label: "Parent / final approval",
		defaultValue: "openai-codex/gpt-5.6-sol",
	},
	worker: {
		env: "PI_OPENCODE_MODEL",
		label: "Default OpenCode worker",
		defaultValue: DEFAULT_MODEL,
	},
	implementer: {
		env: "PI_OPENCODE_PROFILE_IMPLEMENTER",
		label: "Implementer profile",
		defaultValue: MODEL_PROFILE_DEFAULTS.implementer,
	},
	reviewer: {
		env: "PI_OPENCODE_PROFILE_REVIEWER",
		label: "Reviewer profile",
		defaultValue: MODEL_PROFILE_DEFAULTS.reviewer,
	},
	tester: {
		env: "PI_OPENCODE_PROFILE_TESTER",
		label: "Tester profile",
		defaultValue: DEFAULT_MODEL,
	},
} as const;

export type ModelSettingName = keyof typeof MODEL_SETTING_DEFINITIONS;
export type SavedModelSettings = Partial<Record<ModelSettingName, string>>;

/**
 * Canonicalize a single setting value. The parent setting is final-approval
 * output and is intentionally left untouched (only trimmed). Every other
 * (non-parent) value is normalized via normalizeWorkerModelValue so that
 * display-only `opencode:` repetitions never persist or leak into effective
 * values, while `pi::` worker values remain intact.
 */
function normalizeSettingValue(name: ModelSettingName, value: string): string {
	return name === "parent" ? value.trim() : normalizeWorkerModelValue(value);
}

export function modelConfigPath(env: NodeJS.ProcessEnv = process.env) {
	const configDir = process.platform === "win32"
		? join(env.LOCALAPPDATA?.trim() || homedir(), "pi-orch")
		: join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "pi-orch");
	return join(configDir, "models.json");
}

export function loadSavedModelSettings(path = modelConfigPath()): SavedModelSettings {
	if (!existsSync(path)) return {};
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Model config must contain a JSON object: ${path}`);
	}
	const result: SavedModelSettings = {};
	for (const name of Object.keys(MODEL_SETTING_DEFINITIONS) as ModelSettingName[]) {
		const value = (parsed as Record<string, unknown>)[name];
		if (typeof value !== "string" || !value.trim()) continue;
		const normalized = normalizeSettingValue(name, value);
		// Values that normalize away entirely are ignored (in-memory migration
		// only; the file is never eagerly rewritten here).
		if (normalized) result[name] = normalized;
	}
	return result;
}

function writeSavedModelSettings(settings: SavedModelSettings, path = modelConfigPath()) {
	// Canonicalize every persisted value so `opencode:` repetitions never reach
	// disk; values that normalize away entirely are dropped. Parent is left
	// untouched (only trimmed) and `pi::` worker values are preserved.
	const cleaned: SavedModelSettings = {};
	for (const name of Object.keys(MODEL_SETTING_DEFINITIONS) as ModelSettingName[]) {
		const value = settings[name];
		if (typeof value !== "string" || !value.trim()) continue;
		const normalized = normalizeSettingValue(name, value);
		if (normalized) cleaned[name] = normalized;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(cleaned, null, 2)}\n`, "utf8");
}

export function saveModelSetting(name: ModelSettingName, model: string, path = modelConfigPath()) {
	const value = normalizeSettingValue(name, model);
	if (!value || /[\s\0]/.test(value)) throw new Error("Model ID must be a non-empty provider/model value without spaces.");
	const settings = loadSavedModelSettings(path);
	settings[name] = value;
	writeSavedModelSettings(settings, path);
}

export function resetSavedModelSetting(name?: ModelSettingName, path = modelConfigPath()) {
	if (!name) {
		if (existsSync(path)) rmSync(path);
		return;
	}
	const settings = loadSavedModelSettings(path);
	delete settings[name];
	if (Object.keys(settings).length === 0) {
		if (existsSync(path)) rmSync(path);
		return;
	}
	writeSavedModelSettings(settings, path);
}

export function effectiveModelSetting(
	name: ModelSettingName,
	saved: SavedModelSettings = loadSavedModelSettings(),
	env: NodeJS.ProcessEnv = process.env,
) {
	const definition = MODEL_SETTING_DEFINITIONS[name];
	const envValue = normalizeSettingValue(name, env[definition.env] ?? "");
	if (envValue) return envValue;
	const savedValue = saved[name] ? normalizeSettingValue(name, saved[name] as string) : "";
	if (savedValue) return savedValue;
	return normalizeSettingValue(name, definition.defaultValue);
}

export interface ModelConfigWatcher {
	close(): void;
}

export interface WatchModelConfigOptions {
	/** Path of models.json whose parent directory should be watched. */
	path?: string;
	/** Debounce window in milliseconds for collapsing bursts of fs events. */
	debounceMs?: number;
}

/**
 * Watch the directory holding models.json so create/update/delete/rename by an
 * external `pi-orch model ...` command is observed without a process restart.
 *
 * The directory is watched rather than the file because writers typically
 * replace or delete the inode (Windows renames, atomic replace, `rm`), which
 * would otherwise close a file-scoped watcher. The directory is created on
 * demand so a first-ever save is seen, Japanese/Unicode path segments are
 * handled natively by fs.watch, and no polling is used. The watch is
 * re-established with a short backoff if the directory temporarily disappears.
 */
export function watchModelConfig(
	onChange: () => void,
	options: WatchModelConfigOptions = {},
): ModelConfigWatcher {
	const filePath = options.path ?? modelConfigPath();
	const directory = dirname(filePath);
	const debounceMs = Math.max(1, Math.floor(options.debounceMs ?? 120));

	let watcher: FSWatcher | undefined;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let pending = false;
	let closed = false;

	const scheduleChange = () => {
		if (closed || pending) return;
		pending = true;
		debounceTimer = setTimeout(() => {
			debounceTimer = undefined;
			pending = false;
			onChange();
		}, debounceMs);
		debounceTimer.unref?.();
	};

	const rearm = () => {
		if (closed || retryTimer) return;
		retryTimer = setTimeout(start, 500);
		retryTimer.unref?.();
	};

	function start() {
		if (closed) return;
		if (watcher) {
			watcher.close();
			watcher = undefined;
		}
		try {
			watcher = watchFile(directory, { persistent: false }, () => scheduleChange());
			watcher.on("error", () => {
				if (watcher) {
					watcher.close();
					watcher = undefined;
				}
				rearm();
			});
			return;
		} catch {
			// Directory may not exist yet or may have been removed mid-session.
		}
		try {
			mkdirSync(directory, { recursive: true });
			watcher = watchFile(directory, { persistent: false }, () => scheduleChange());
			watcher.on("error", () => {
				if (watcher) {
					watcher.close();
					watcher = undefined;
				}
				rearm();
			});
		} catch {
			rearm();
		}
	}

	start();

	return {
		close() {
			closed = true;
			if (debounceTimer) clearTimeout(debounceTimer);
			if (retryTimer) clearTimeout(retryTimer);
			if (watcher) watcher.close();
			watcher = undefined;
			debounceTimer = undefined;
			retryTimer = undefined;
		},
	};
}
