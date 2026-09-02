import { execFile } from "node:child_process";
import { countRetainedWorktrees, type RetainedWorktreeCount } from "./dashboard.ts";
import type { TaskSnapshot, WorkflowSnapshot } from "./types.ts";

/**
 * Optional Herdr status integration. When the orchestrator runs inside a Herdr
 * pane (HERDR_ENV=1 with HERDR_PANE_ID and HERDR_BIN_PATH inherited), the
 * orchestrator's real state is reported through the official Herdr CLI
 * (`pane report-agent` / `pane release-agent`). Outside Herdr this module is a
 * complete no-op, and every CLI failure is confined to bounded diagnostics: it
 * never fails the orchestrator and is never used for permission decisions.
 *
 * State mapping (counts only; messages never contain prompts, paths, or secrets):
 * - blocked: retained/cleanup-failed worktrees await a parent decision
 * - working: at least one worker or workflow is running
 * - idle: nothing running and nothing awaiting a decision
 */

export const HERDR_SOURCE = "custom:pi-orch";
export const HERDR_AGENT = "pi-orch";

export type HerdrAgentState = "idle" | "working" | "blocked";

export interface HerdrEnv {
	paneId: string;
	binPath: string;
}

export interface HerdrStatus {
	state: HerdrAgentState;
	message: string;
}

/** Enabled only inside a Herdr pane with a usable CLI path; otherwise no-op. */
export function resolveHerdrEnv(env: NodeJS.ProcessEnv = process.env): HerdrEnv | undefined {
	if (env.HERDR_ENV !== "1") return undefined;
	const paneId = (env.HERDR_PANE_ID ?? "").trim();
	const binPath = (env.HERDR_BIN_PATH ?? "").trim();
	if (!paneId || !binPath) return undefined;
	return { paneId, binPath };
}

export function deriveHerdrStatus(
	tasks: TaskSnapshot[],
	workflows: WorkflowSnapshot[],
	retained: RetainedWorktreeCount = countRetainedWorktrees(tasks),
): HerdrStatus {
	if (retained.total > 0) {
		const details = retained.cleanupFailed > 0 ? ` (${retained.cleanupFailed} cleanup-failed)` : "";
		return {
			state: "blocked",
			message: `${retained.total} retained worktree(s)${details} awaiting decision`,
		};
	}
	const runningWorkers = tasks.filter((task) => task.status === "running").length;
	const runningWorkflows = workflows.filter((workflow) => workflow.status === "running").length;
	if (runningWorkers > 0 || runningWorkflows > 0) {
		return {
			state: "working",
			message: `${runningWorkers} worker(s) running, ${runningWorkflows} workflow(s) running`,
		};
	}
	return { state: "idle", message: "no running workers or workflows" };
}

export function buildReportArgs(paneId: string, status: HerdrStatus, seq: number): string[] {
	return [
		"pane",
		"report-agent",
		paneId,
		"--source",
		HERDR_SOURCE,
		"--agent",
		HERDR_AGENT,
		"--state",
		status.state,
		"--message",
		status.message,
		"--seq",
		String(seq),
	];
}

export function buildReleaseArgs(paneId: string, seq: number): string[] {
	return ["pane", "release-agent", paneId, "--source", HERDR_SOURCE, "--agent", HERDR_AGENT, "--seq", String(seq)];
}

export interface HerdrReporterOptions {
	env: HerdrEnv;
	/** Extra args inserted between the binary and the built CLI args (test injection). */
	binArgs?: string[];
	maxDiagnostics?: number;
}

const DEFAULT_MAX_DIAGNOSTICS = 8;
const CLI_TIMEOUT_MS = 5_000;

/**
 * Fire-and-forget Herdr status reporter. Reports are sent only when the derived
 * status changes, with a monotonically increasing seq shared with the final
 * release. Every failure lands in bounded `diagnostics` and nowhere else.
 * Dispatched CLI subprocesses are tracked in-flight so `flush()` can await
 * their completion (used by tests and session shutdown).
 */
export class HerdrStatusReporter {
	readonly diagnostics: string[] = [];
	private readonly options: Required<Pick<HerdrReporterOptions, "env">> & HerdrReporterOptions;
	private seq = 0;
	private lastReported?: HerdrStatus;
	private released = false;
	private reportsSent = 0;
	private readonly inflight = new Set<Promise<void>>();
	private tail: Promise<void> = Promise.resolve();

	constructor(options: HerdrReporterOptions) {
		this.options = { maxDiagnostics: DEFAULT_MAX_DIAGNOSTICS, ...options };
	}

	get lastStatus(): HerdrStatus | undefined {
		return this.lastReported ? { ...this.lastReported } : undefined;
	}

	get reportsCount(): number {
		return this.reportsSent;
	}

	/** Idempotent per unique status; no-op outside Herdr envs is guaranteed by the factory. */
	report(tasks: TaskSnapshot[], workflows: WorkflowSnapshot[]): void {
		if (this.released) return;
		const status = deriveHerdrStatus(tasks, workflows);
		const previous = this.lastReported;
		// Herdr ownership is keyed by the coarse state. Counts are deliberately
		// not reported again while that state remains unchanged.
		if (previous && previous.state === status.state) return;
		this.lastReported = status;
		this.reportsSent += 1;
		this.seq += 1;
		this.dispatch("report", buildReportArgs(this.options.env.paneId, status, this.seq), this.seq);
	}

	/** Ends this source's lifecycle authority at session shutdown; never repeats. */
	release(): void {
		if (this.released) return;
		this.released = true;
		this.seq += 1;
		this.dispatch("release", buildReleaseArgs(this.options.env.paneId, this.seq), this.seq);
	}

	/** Resolves once every dispatched CLI subprocess has settled (success or failure). */
	async flush(): Promise<void> {
		await this.tail;
		while (this.inflight.size > 0) {
			await Promise.allSettled([...this.inflight]);
		}
	}

	private dispatch(kind: "report" | "release", args: string[], seq: number): void {
		const record = (error: unknown) => this.recordDiagnostic(kind, seq, error);
		let settle!: () => void;
		const done = new Promise<void>((resolve) => {
			settle = () => {
				this.inflight.delete(done);
				resolve();
			};
		});
		this.inflight.add(done);
		// Dispatches are serialized: Herdr applies statuses by seq, so concurrent
		// CLI calls could land out of order and let a stale state win. The chain
		// link must resolve only when the previous execFile callback fired (not
		// merely when it was spawned), so the next call starts after the previous
		// one settled and seq order holds.
		this.tail = this.tail.then(
			() =>
				new Promise<void>((resolve) => {
					try {
						execFile(
							this.options.env.binPath,
							[...(this.options.binArgs ?? []), ...args],
							{ windowsHide: true, timeout: CLI_TIMEOUT_MS },
							(error) => {
								record(error);
								settle();
								resolve();
							},
						);
					} catch (error) {
						record(error);
						settle();
						resolve();
					}
				}),
		);
	}

	/** Bounded, path-free diagnostic: error code only, never a message with paths. */
	private recordDiagnostic(kind: string, seq: number, error: unknown): void {
		if (!error) return;
		const code = typeof error === "object" && error !== null && "code" in error
			? String((error as { code: unknown }).code)
			: "unknown";
		this.diagnostics.push(`herdr ${kind} failed (seq ${seq}): ${code}`);
		while (this.diagnostics.length > (this.options.maxDiagnostics ?? DEFAULT_MAX_DIAGNOSTICS)) {
			this.diagnostics.shift();
		}
	}
}
