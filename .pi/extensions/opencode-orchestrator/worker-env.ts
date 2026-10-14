import * as os from "node:os";
import * as path from "node:path";

// Environment passed to worker child processes. Keep this list deliberately
// small: provider credentials are normally read from each CLI's saved auth
// store, not inherited from the orchestrator process.
export const DEFAULT_WORKER_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USERPROFILE",
	"TEMP",
	"TMP",
	"TMPDIR",
	"SYSTEMROOT",
	"COMSPEC",
	"PATHEXT",
	"APPDATA",
	"LOCALAPPDATA",
	"GH_CONFIG_DIR",
	"XDG_CONFIG_HOME",
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"locale",
	"TERM",
	"TERM_PROGRAM",
	"COLORTERM",
	"CI",
	"OPENCODE_CONFIG_CONTENT",
	"PI_EXECUTOR_BIN",
] as const;

const ALLOWLIST_ENV = "PI_ORCH_WORKER_ENV_ALLOWLIST";

function configuredNames(value: string | undefined): string[] {
	if (!value) return [];
	return value.split(/[\s,;]+/).map((name) => name.trim()).filter(Boolean);
}

export function sourceKey(source: NodeJS.ProcessEnv, requested: string): string | undefined {
	if (source[requested] !== undefined) return requested;
	const folded = requested.toLowerCase();
	return Object.keys(source).find((key) => key.toLowerCase() === folded && source[key] !== undefined);
}

function lookupValue(source: NodeJS.ProcessEnv, requested: string): string | undefined {
	const actual = sourceKey(source, requested);
	return actual !== undefined ? source[actual] : undefined;
}

/**
 * Canonical GitHub CLI config directory for a worker child, following the
 * official gh contract (https://cli.github.com/manual/gh_help_environment):
 * explicit GH_CONFIG_DIR wins, then $XDG_CONFIG_HOME/gh, then (Windows only)
 * $AppData/GitHub CLI, then $HOME/.config/gh. Only the supplied source is
 * read; ambient process.env is never consulted here. Explicit directories are
 * used verbatim (no trimming) so valid paths with spaces keep working.
 */
export function resolveGhConfigDir(
	source: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	const explicit = lookupValue(source, "GH_CONFIG_DIR");
	if (explicit !== undefined && explicit !== "") return explicit;
	const xdg = lookupValue(source, "XDG_CONFIG_HOME");
	if (xdg !== undefined && xdg !== "") return path.join(xdg, "gh");
	if (platform === "win32") {
		const appData = lookupValue(source, "AppData");
		if (appData !== undefined && appData !== "") return path.join(appData, "GitHub CLI");
	}
	const home = lookupValue(source, "HOME") ?? lookupValue(source, "USERPROFILE");
	let base = home !== undefined && home !== "" ? home : undefined;
	if (base === undefined) {
		try {
			const fallback = os.homedir();
			if (fallback !== "") base = fallback;
		} catch {
			base = undefined;
		}
	}
	if (base === undefined) return undefined;
	return path.join(base, ".config", "gh");
}

/**
 * Return the child environment without inheriting arbitrary parent variables.
 * Explicit names in PI_ORCH_WORKER_ENV_ALLOWLIST are additive and are never
 * surfaced by this helper; this is only an environment construction boundary.
 */
export function buildWorkerEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const names = new Set<string>([
		...DEFAULT_WORKER_ENV_ALLOWLIST,
		...configuredNames(source[ALLOWLIST_ENV]),
	]);
	const result: NodeJS.ProcessEnv = {};
	for (const requested of names) {
		const actual = sourceKey(source, requested);
		if (actual !== undefined) result[actual] = source[actual];
	}
	return result;
}
