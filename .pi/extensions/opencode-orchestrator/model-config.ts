import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_MODEL, MODEL_PROFILE_DEFAULTS } from "./types.ts";

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
	glm: {
		env: "PI_OPENCODE_PROFILE_GLM",
		label: "GLM profile",
		defaultValue: MODEL_PROFILE_DEFAULTS.glm,
	},
	kimi: {
		env: "PI_OPENCODE_PROFILE_KIMI_K3",
		label: "Kimi review profile",
		defaultValue: MODEL_PROFILE_DEFAULTS.kimi_k3,
	},
} as const;

export type ModelSettingName = keyof typeof MODEL_SETTING_DEFINITIONS;
export type SavedModelSettings = Partial<Record<ModelSettingName, string>>;

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
		if (typeof value === "string" && value.trim()) result[name] = value.trim();
	}
	return result;
}

function writeSavedModelSettings(settings: SavedModelSettings, path = modelConfigPath()) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export function saveModelSetting(name: ModelSettingName, model: string, path = modelConfigPath()) {
	const value = model.trim();
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
	return env[definition.env]?.trim() || saved[name]?.trim() || definition.defaultValue;
}
