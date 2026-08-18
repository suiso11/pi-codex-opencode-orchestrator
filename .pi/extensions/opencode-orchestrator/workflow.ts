import type { OpenCodeTaskManager } from "./manager.ts";
import type {
	TaskMode,
	TaskSnapshot,
	WorkflowPhaseSpec,
	WorkflowSnapshot,
} from "./types.ts";
import { taskResultsText, validateWorkflowPhases } from "./types.ts";

interface ManagedWorkflow {
	snapshot: WorkflowSnapshot;
	abortController: AbortController;
	settleListeners: Set<() => void>;
	waiters: number;
	consumed: boolean;
	delivered: boolean;
}

interface WorkflowManagerOptions {
	onChange?: () => void;
}

const HANDOFF_MAX_CHARS = 4_000;
const FINAL_RESULT_MAX_CHARS = 8_000;

export class OpenCodeWorkflowManager {
	private readonly workflows = new Map<string, ManagedWorkflow>();
	private counter = 0;
	private readonly onChange?: () => void;

	private readonly tasks: OpenCodeTaskManager;

	constructor(tasks: OpenCodeTaskManager, options: WorkflowManagerOptions = {}) {
		this.tasks = tasks;
		this.onChange = options.onChange;
	}

	private notify() {
		this.onChange?.();
	}

	start(name: string, phases: WorkflowPhaseSpec[], cwd: string) {
		validateWorkflowPhases(cwd, phases);
		const id = `ow-${++this.counter}`;
		const snapshot: WorkflowSnapshot = {
			id,
			name: name.trim().slice(0, 160) || id,
			status: "running",
			phases,
			taskIds: [],
			createdAt: Date.now(),
			handoffCharsCreated: 0,
			handoffCharsInjected: 0,
		};
		const entry: ManagedWorkflow = {
			snapshot,
			abortController: new AbortController(),
			settleListeners: new Set(),
			waiters: 0,
			consumed: false,
			delivered: false,
		};
		this.workflows.set(id, entry);
		void this.run(entry, cwd);
		this.notify();
		return snapshot;
	}

	private async run(entry: ManagedWorkflow, cwd: string) {
		const { signal } = entry.abortController;
		let priorPhaseContext = "";
		try {
			for (let phaseIndex = 0; phaseIndex < entry.snapshot.phases.length; phaseIndex++) {
				if (signal.aborted) throw new Error("Workflow was cancelled.");
				entry.snapshot.currentPhase = phaseIndex;
				this.notify();
				const phase = entry.snapshot.phases[phaseIndex];
				const phaseTasks: TaskSnapshot[] = [];
				for (const originalSpec of phase.tasks) {
					const spec = priorPhaseContext
						? {
							...originalSpec,
							constraints: [
								...originalSpec.constraints,
								buildHandoffConstraint(originalSpec.mode, priorPhaseContext),
							],
						}
						: originalSpec;
					const task = await this.tasks.spawnWhenAvailable(
						{ ...spec, workflowId: entry.snapshot.id },
						cwd,
						signal,
					);
					phaseTasks.push(task);
					entry.snapshot.taskIds.push(task.id);
					if (priorPhaseContext) {
						entry.snapshot.handoffCharsInjected = (entry.snapshot.handoffCharsInjected ?? 0) + priorPhaseContext.length;
					}
					this.notify();
				}
				const results = await this.tasks.wait(
					phaseTasks.map((task) => task.id),
					signal,
					true,
				);
				const failed = results.filter((task) => task.status !== "done");
				if (failed.length > 0) {
					throw new Error(
						`Phase "${phase.name}" failed: ${failed.map((task) => `${task.id}=${task.status}`).join(", ")}`,
					);
				}
				priorPhaseContext = buildPhaseHandoff(results);
				const downstreamPhase = entry.snapshot.phases[phaseIndex + 1];
				if (downstreamPhase && priorPhaseContext) {
					entry.snapshot.handoffCharsCreated = (entry.snapshot.handoffCharsCreated ?? 0) + priorPhaseContext.length;
					this.notify();
				}
			}
			entry.snapshot.status = "done";
		} catch (error) {
			if (signal.aborted) entry.snapshot.status = "cancelled";
			else entry.snapshot.status = "error";
			entry.snapshot.error = error instanceof Error ? error.message : String(error);
		} finally {
			entry.snapshot.settledAt = Date.now();
			for (const listener of entry.settleListeners) listener();
			entry.settleListeners.clear();
			this.notify();
		}
	}

	get(id: string) {
		return this.workflows.get(id)?.snapshot;
	}

	list() {
		return [...this.workflows.values()].map((entry) => entry.snapshot);
	}

	private waitOne(entry: ManagedWorkflow, signal?: AbortSignal) {
		if (entry.snapshot.status !== "running") return Promise.resolve();
		if (signal?.aborted) return Promise.reject(new Error("Workflow wait was aborted; workflow keeps running."));
		return new Promise<void>((resolve, reject) => {
			const listener = () => {
				cleanup();
				resolve();
			};
			const onAbort = () => {
				cleanup();
				reject(new Error("Workflow wait was aborted; workflow keeps running."));
			};
			const cleanup = () => {
				entry.settleListeners.delete(listener);
				signal?.removeEventListener("abort", onAbort);
			};
			entry.settleListeners.add(listener);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	async wait(id: string, signal?: AbortSignal, consume = true) {
		const entry = this.workflows.get(id);
		if (!entry) throw new Error(`Unknown OpenCode workflow id: ${id}`);
		entry.waiters++;
		try {
			await this.waitOne(entry, signal);
			if (consume) entry.consumed = true;
			return entry.snapshot;
		} finally {
			entry.waiters = Math.max(0, entry.waiters - 1);
		}
	}

	async cancel(id: string) {
		const entry = this.workflows.get(id);
		if (!entry) throw new Error(`Unknown OpenCode workflow id: ${id}`);
		entry.consumed = true;
		if (entry.snapshot.status === "running") {
			entry.abortController.abort();
			const activeTaskIds = entry.snapshot.taskIds.filter(
				(taskId) => this.tasks.get(taskId)?.status === "running",
			);
			if (activeTaskIds.length > 0) await this.tasks.cancel(activeTaskIds);
		}
		return this.wait(id, undefined, true);
	}

	drainDeliverable() {
		const ready: WorkflowSnapshot[] = [];
		for (const entry of this.workflows.values()) {
			if (
				entry.snapshot.status !== "running" &&
				!entry.consumed &&
				!entry.delivered &&
				entry.waiters === 0
			) {
				entry.delivered = true;
				ready.push(entry.snapshot);
			}
		}
		return ready;
	}

	resultText(workflow: WorkflowSnapshot) {
		const results = workflow.status !== "running"
			? workflow.taskIds
				.map((id) => this.tasks.get(id))
				.filter((task): task is TaskSnapshot => task !== undefined)
			: [];
		return formatWorkflowResultText(workflow, results);
	}

	async dispose() {
		const running = [...this.workflows.values()].filter((entry) => entry.snapshot.status === "running");
		for (const entry of running) entry.abortController.abort();
		const taskIds = running.flatMap((entry) => entry.snapshot.taskIds)
			.filter((id) => this.tasks.get(id)?.status === "running");
		if (taskIds.length > 0) await this.tasks.cancel(taskIds);
		await Promise.all(running.map((entry) => this.waitOne(entry).catch(() => undefined)));
	}
}

export function formatWorkflowResultText(workflow: WorkflowSnapshot, results: TaskSnapshot[]): string {
	const phase = workflow.currentPhase === undefined
		? "not started"
		: `${workflow.currentPhase + 1}/${workflow.phases.length} ${workflow.phases[workflow.currentPhase]?.name ?? ""}`;
	const lines = [
		`${workflow.id} [${workflow.status}] "${workflow.name}"`,
		`Phase: ${phase}`,
		`Tasks: ${workflow.taskIds.join(", ") || "none"}`,
	];
	if (workflow.error) lines.push(`Error: ${workflow.error}`);
	const created = workflow.handoffCharsCreated ?? 0;
	const injected = workflow.handoffCharsInjected ?? 0;
	if (created > 0 || injected > 0) {
		lines.push(`Handoff: ${created} unique chars created, ${injected} chars injected downstream`);
	}
	if (results.length > 0) lines.push("", taskResultsText(results, FINAL_RESULT_MAX_CHARS));
	const text = lines.join("\n");
	if (text.length <= FINAL_RESULT_MAX_CHARS) return text;
	const marker = "\n[Workflow result truncated.]";
	const budget = FINAL_RESULT_MAX_CHARS - marker.length;
	if (budget <= 0) return text.slice(0, FINAL_RESULT_MAX_CHARS);
	return `${text.slice(0, budget)}${marker}`;
}

export function buildPhaseHandoff(results: TaskSnapshot[]): string {
	const tasks = results.map((task) => {
		const report = task.report ?? { summary: "", files: [], findings: [], unresolved: [] };
		return {
			id: task.id,
			name: task.name,
			status: task.status,
			report: {
				summary: report.summary,
				files: report.files,
				findings: report.findings,
				unresolved: report.unresolved,
			},
		};
	});
	const fullPayload = JSON.stringify({ tasks });
	if (fullPayload.length <= HANDOFF_MAX_CHARS) return fullPayload;
	const trimmed = tasks.map((task) => ({
		id: task.id,
		name: task.name.slice(0, 80),
		status: task.status,
		report: {
			summary: task.report.summary.slice(0, 600),
			files: task.report.files.slice(0, 8).map((f) => f.slice(0, 120)),
			findings: task.report.findings.slice(0, 4).map((f) => f.slice(0, 300)),
			unresolved: task.report.unresolved.slice(0, 4).map((f) => f.slice(0, 200)),
		},
	}));
	const trimmedPayload = JSON.stringify({ tasks: trimmed });
	if (trimmedPayload.length <= HANDOFF_MAX_CHARS) return trimmedPayload;
	const minimal = tasks.map((task) => ({
		id: task.id,
		name: task.name.slice(0, 80),
		status: task.status,
		report: {
			summary: task.report.summary.slice(0, 400),
			files: task.report.files.slice(0, 4).map((f) => f.slice(0, 120)),
			findings: [] as string[],
			unresolved: [] as string[],
		},
	}));
	const minimalPayload = JSON.stringify({ tasks: minimal });
	if (minimalPayload.length <= HANDOFF_MAX_CHARS) return minimalPayload;
	for (let keep = minimal.length - 1; keep > 0; keep--) {
		const candidate = JSON.stringify({ tasks: minimal.slice(0, keep), omittedTasks: minimal.length - keep });
		if (candidate.length <= HANDOFF_MAX_CHARS) return candidate;
	}
	return JSON.stringify({ tasks: [], omittedTasks: minimal.length, truncated: true });
}

function buildHandoffConstraint(mode: TaskMode, handoff: string): string {
	const base = `Previous phase results (compact JSON; use as input, verify before trusting):\n${handoff}`;
	if (mode === "write") {
		return `${base}\nInspect changed files directly rather than relying on prose; the JSON above lists files and findings only.`;
	}
	return base;
}
