#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
	dirname,
	join,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";

const MODEL_SETTINGS = {
	parent: {
		env: "PI_CODEX_MODEL",
		label: "Parent / final approval",
		defaultValue: "openai-codex/gpt-5.6-sol",
	},
	worker: {
		env: "PI_OPENCODE_MODEL",
		label: "Default OpenCode worker",
		defaultValue: "opencode-go/glm-5.2",
	},
	implementer: {
		env: "PI_OPENCODE_PROFILE_IMPLEMENTER",
		label: "Implementer profile",
		defaultValue: "opencode-go/glm-5.2",
	},
	reviewer: {
		env: "PI_OPENCODE_PROFILE_REVIEWER",
		label: "Reviewer profile",
		defaultValue: "opencode-go/kimi-k3",
	},
	tester: {
		env: "PI_OPENCODE_PROFILE_TESTER",
		label: "Tester profile",
		defaultValue: "opencode-go/glm-5.2",
	},
};

const configDir = process.platform === "win32"
	? join(process.env.LOCALAPPDATA || homedir(), "pi-orch")
	: join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pi-orch");
const configPath = join(configDir, "models.json");

function loadConfig() {
	if (!existsSync(configPath)) return {};
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch (error) {
		console.error(`Could not read ${configPath}: ${error.message}`);
		process.exit(1);
	}
}

function saveConfig(config) {
	mkdirSync(configDir, { recursive: true });
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function printModels(config) {
	console.log("pi-orch model settings\n");
	for (const [name, setting] of Object.entries(MODEL_SETTINGS)) {
		const environmentValue = process.env[setting.env]?.trim();
		const savedValue = typeof config[name] === "string" ? config[name].trim() : "";
		const value = environmentValue || savedValue || setting.defaultValue;
		const displayValue = name !== "parent" && value.startsWith("pi::")
			? `pi -> ${value.slice("pi::".length)}`
			: name !== "parent" ? `opencode -> ${value}` : value;
		const source = environmentValue ? setting.env : savedValue ? "saved" : "default";
		console.log(`${name.padEnd(7)} ${displayValue}  (${source})`);
	}
  const parentThinking = process.env.PI_CODEX_THINKING?.trim() || "high";
  const workerThinking = process.env.PI_OPENCODE_THINKING?.trim() || "high";
	console.log(`\nThinking  parent ${parentThinking}  worker ${workerThinking}  (per-task: low|medium|high)`);
	console.log(`  PI_CODEX_THINKING / PI_OPENCODE_THINKING override; use low explicitly for faster responses.`);
	console.log(`\nConfig: ${configPath}`);
	console.log("Change: pi-orch model <parent|worker|implementer|reviewer|tester> [pi|opencode] <provider/model>");
	console.log("Reset:  pi-orch model reset [parent|worker|implementer|reviewer|tester]");
}

function handleModelCommand(args) {
	const config = loadConfig();
	if (args.length === 0 || args[0] === "show" || args[0] === "list") {
		printModels(config);
		return;
	}

	if (args[0] === "reset") {
		const target = args[1];
		if (!target) {
			if (existsSync(configPath)) rmSync(configPath);
			console.log("Reset all saved pi-orch model settings.");
			return;
		}
		if (!MODEL_SETTINGS[target]) {
			console.error(`Unknown model target: ${target}`);
			process.exitCode = 2;
			return;
		}
		delete config[target];
		saveConfig(config);
		console.log(`Reset ${target} to ${MODEL_SETTINGS[target].defaultValue}.`);
		return;
	}

	const [target, ...modelParts] = args;
	let model = modelParts.join(" ").trim();
	if (target !== "parent" && (modelParts[0] === "pi" || modelParts[0] === "opencode")) {
		const backend = modelParts.shift();
		model = modelParts.join(" ").trim();
		if (backend === "pi") model = `pi::${model}`;
	}
	if (!MODEL_SETTINGS[target] || !model || /[\r\n\0]/.test(model)) {
		console.error("Usage: pi-orch model <parent|worker|implementer|reviewer|tester> [pi|opencode] <provider/model>");
		process.exitCode = 2;
		return;
	}
	config[target] = model;
	saveConfig(config);
	console.log(`Saved ${target}: ${model}`);
	console.log(`Running Pi sessions apply this change without restart.`);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const isWindows = process.platform === "win32";
const cliArgs = process.argv.slice(2);

if (cliArgs[0] === "model" || cliArgs[0] === "models") {
	handleModelCommand(cliArgs[0] === "models" ? ["show"] : cliArgs.slice(1));
	process.exit(process.exitCode ?? 0);
}

const config = loadConfig();
const childEnv = { ...process.env };
const appliedSavedSettings = [];
for (const [name, setting] of Object.entries(MODEL_SETTINGS)) {
	if (!childEnv[setting.env] && typeof config[name] === "string" && config[name].trim()) {
		childEnv[setting.env] = config[name].trim();
		appliedSavedSettings.push(name);
	}
}
if (appliedSavedSettings.length > 0) {
	childEnv.PI_ORCH_SAVED_SETTINGS = appliedSavedSettings.join(",");
}
const launcher = join(
  root,
  "scripts",
  isWindows ? "pi_codex_orchestrator.ps1" : "pi_codex_orchestrator.sh",
);

const command = isWindows ? "powershell.exe" : "bash";
const commandArgs = isWindows
	? ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, ...cliArgs]
	: [launcher, ...cliArgs];

const result = spawnSync(command, commandArgs, {
  cwd: process.cwd(),
	env: childEnv,
  stdio: "inherit",
});

if (result.error) {
  console.error(`Failed to launch Pi orchestrator: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
