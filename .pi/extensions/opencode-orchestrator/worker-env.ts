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

function sourceKey(source: NodeJS.ProcessEnv, requested: string): string | undefined {
	if (source[requested] !== undefined) return requested;
	const folded = requested.toLowerCase();
	return Object.keys(source).find((key) => key.toLowerCase() === folded && source[key] !== undefined);
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
