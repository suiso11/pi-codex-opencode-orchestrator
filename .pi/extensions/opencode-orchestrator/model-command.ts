import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { OpenCodeTaskManager } from "./manager.ts";
import {
	decodeWorkerModel,
	encodeWorkerModel,
	type WorkerBackend,
} from "./types.ts";
import {
	effectiveModelSetting,
	loadSavedModelSettings,
	MODEL_SETTING_DEFINITIONS,
	modelConfigPath,
	resetSavedModelSetting,
	saveModelSetting,
	type ModelSettingName,
} from "./model-config.ts";

const TARGETS = Object.keys(MODEL_SETTING_DEFINITIONS) as ModelSettingName[];
const MANUAL_ENTRY = "Enter a model ID manually...";

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

function currentModel(name: ModelSettingName, ctx: ExtensionCommandContext, tasks: OpenCodeTaskManager) {
	if (name === "parent") {
		return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : effectiveModelSetting(name);
	}
	const config = tasks.configuration();
	if (name === "worker") return config.model;
	if (name === "glm") return config.profiles.glm;
	return config.profiles.kimi_k3;
}

async function availableModels(
	pi: ExtensionAPI,
	backend: WorkerBackend | "parent",
	ctx: ExtensionCommandContext,
	tasks: OpenCodeTaskManager,
) {
	if (backend === "parent" || backend === "pi") {
		await ctx.modelRegistry.refresh();
		return ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`);
	}
	const binary = tasks.configuration().binary;
	const result = await pi.exec(binary, ["models"], { cwd: ctx.cwd, timeout: 30_000 });
	if (result.code !== 0) {
		ctx.ui.notify(`Could not list OpenCode models: ${result.stderr.trim() || `exit ${result.code}`}`, "warning");
		return [];
	}
	return parseOpenCodeModels(result.stdout);
}

async function chooseTarget(ctx: ExtensionCommandContext) {
	const labels = TARGETS.map((name) => `${name} — ${MODEL_SETTING_DEFINITIONS[name].label}`);
	const selected = await ctx.ui.select("Which model do you want to change?", labels);
	return selected?.split(" — ", 1)[0] as ModelSettingName | undefined;
}

async function chooseModel(
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
	const discovered = await availableModels(pi, backend, ctx, tasks);
	const currentForBackend = name === "parent" || decodeWorkerModel(configured).backend === backend ? current : undefined;
	const values = [...new Set([currentForBackend, ...discovered].filter((value): value is string => Boolean(value)))].sort((left, right) => {
		if (left === currentForBackend) return -1;
		if (right === currentForBackend) return 1;
		return left.localeCompare(right);
	});
	const labels = [...values.map((value) => value === currentForBackend ? `Current: ${value}` : value), MANUAL_ENTRY];
	const selected = await ctx.ui.select(`${MODEL_SETTING_DEFINITIONS[name].label} model`, labels);
	if (!selected) return undefined;
	const chosen = selected === MANUAL_ENTRY
		? await ctx.ui.input("Provider/model ID", currentForBackend ?? "provider/model")
		: selected.startsWith("Current: ") ? selected.slice("Current: ".length) : selected;
	if (!chosen) return undefined;
	return name === "parent" ? chosen : encodeWorkerModel(backend as WorkerBackend, chosen);
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
		const managerTarget = name === "kimi" ? "kimi_k3" : name;
		tasks.setModelSetting(managerTarget, encodeWorkerModel(selection!.backend, parsed.value));
	}
	return true;
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
) {
	if (!await activateModel(pi, name, value, ctx, tasks)) return;
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
) {
	const targets = name ? [name] : TARGETS;
	for (const target of targets) {
		const defaultValue = MODEL_SETTING_DEFINITIONS[target].defaultValue;
		if (!await activateModel(pi, target, defaultValue, ctx, tasks)) return;
	}
	resetSavedModelSetting(name);
	ctx.ui.notify(name ? `Reset ${name} to its default.` : "Reset all orchestrator models to their defaults.", "info");
}

export function registerModelCommand(pi: ExtensionAPI, tasks: OpenCodeTaskManager) {
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
				await resetSetting(pi, target, ctx, tasks);
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
				await setAndSave(pi, target, modelValue, ctx, tasks);
				return;
			}

			const target = await chooseTarget(ctx);
			if (!target) return;
			const model = await chooseModel(pi, target, ctx, tasks);
			if (!model) return;
			await setAndSave(pi, target, model, ctx, tasks);
		},
	});
}
