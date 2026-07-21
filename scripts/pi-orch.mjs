#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const isWindows = process.platform === "win32";
const launcher = join(
  root,
  "scripts",
  isWindows ? "pi_codex_orchestrator.ps1" : "pi_codex_orchestrator.sh",
);

const command = isWindows ? "powershell.exe" : "bash";
const commandArgs = isWindows
  ? ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, ...process.argv.slice(2)]
  : [launcher, ...process.argv.slice(2)];

const result = spawnSync(command, commandArgs, {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  console.error(`Failed to launch Pi orchestrator: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
