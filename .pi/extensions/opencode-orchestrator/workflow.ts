import type { OpenCodeTaskManager } from "./manager.ts";
import type {
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
								`Previous phase results (use as input, verify before trusting):\n${priorPhaseContext}`,
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
				priorPhaseContext = taskResultsText(results, 24_000);
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
		const phase = workflow.currentPhase === undefined
			? "not started"
			: `${workflow.currentPhase + 1}/${workflow.phases.length} ${workflow.phases[workflow.currentPhase]?.name ?? ""}`;
		const lines = [
			`${workflow.id} [${workflow.status}] "${workflow.name}"`,
			`Phase: ${phase}`,
			`Tasks: ${workflow.taskIds.join(", ") || "none"}`,
		];
		if (workflow.error) lines.push(`Error: ${workflow.error}`);
		if (workflow.status !== "running") {
			const results = workflow.taskIds
				.map((id) => this.tasks.get(id))
				.filter((task): task is TaskSnapshot => task !== undefined);
			if (results.length > 0) lines.push("", taskResultsText(results, 60_000));
		}
		return lines.join("\n");
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
