import type { TaskSnapshot, TaskUsage, WorkflowSnapshot } from "./types.ts";

export const DASHBOARD_KEY = "opencode-orchestrator-dashboard";
export const DASHBOARD_INTERVAL_MS = 1000;
export const MAX_DASHBOARD_LINES = 10;

export type DashboardParentUsage = {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cost: number;
};

export type DashboardUsage = {
	parent?: DashboardParentUsage;
};

export function sumWorkerUsage(tasks: TaskSnapshot[]): {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cost: number;
} {
	const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
	for (const task of tasks) {
		const usage: TaskUsage | undefined = task.usage;
		if (!usage) continue;
		totals.inputTokens += usage.inputTokens ?? 0;
		totals.outputTokens += usage.outputTokens ?? 0;
		totals.totalTokens += usage.totalTokens ?? 0;
		totals.cost += usage.cost ?? 0;
	}
	return totals;
}

export function formatTokenTotals(tasks: TaskSnapshot[], usage?: DashboardUsage): string {
	const worker = sumWorkerUsage(tasks);
	const parts: string[] = [];
	if (usage?.parent) {
		parts.push(`parent in ${usage.parent.inputTokens.toLocaleString()}/out ${usage.parent.outputTokens.toLocaleString()}/${usage.parent.totalTokens.toLocaleString()}`);
	}
	parts.push(`workers in ${worker.inputTokens.toLocaleString()}/out ${worker.outputTokens.toLocaleString()}/${worker.totalTokens.toLocaleString()}`);
	return `Tokens: ${parts.join(" · ")}`;
}

export function formatElapsed(now: number, startedAt: number, settledAt?: number): string {
	const elapsed = Math.max(0, Math.floor(((settledAt ?? now) - startedAt) / 1000));
	if (elapsed < 60) return `${elapsed}s`;
	const minutes = Math.floor(elapsed / 60);
	const seconds = elapsed % 60;
	if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	return `${hours}h${mins.toString().padStart(2, "0")}m`;
}

export function formatLatestActivity(activity: string[]): string {
	return activity[activity.length - 1] ?? "starting";
}

export function formatWorkerRow(task: TaskSnapshot, now: number): string {
	const elapsed = formatElapsed(now, task.createdAt, task.settledAt);
	const latest = formatLatestActivity(task.activity);
	return `  ${task.id} ${task.backend}:${task.model} ${elapsed} [${task.mode}] "${task.name}" · ${latest}`;
}

export function formatWorkflowPhase(workflow: WorkflowSnapshot): string {
	if (workflow.currentPhase === undefined) return "-";
	return `${workflow.currentPhase + 1}/${workflow.phases.length} ${workflow.phases[workflow.currentPhase]?.name ?? ""}`;
}

export function formatWorkflowRow(workflow: WorkflowSnapshot, now: number): string {
	const elapsed = formatElapsed(now, workflow.createdAt, workflow.settledAt);
	return `  ${workflow.id} ${elapsed} · phase ${formatWorkflowPhase(workflow)}`;
}

export function formatDashboard(
	tasks: TaskSnapshot[],
	workflows: WorkflowSnapshot[],
	now: number,
	usage?: DashboardUsage,
): string[] | undefined {
	const runningWorkers = tasks.filter((task) => task.status === "running");
	const runningWorkflows = workflows.filter((workflow) => workflow.status === "running");
	if (runningWorkers.length === 0 && runningWorkflows.length === 0) return undefined;
	const lines: string[] = [
		`Worker activity: ${runningWorkers.length} worker(s), ${runningWorkflows.length} workflow(s)`,
		formatTokenTotals(tasks, usage),
	];
	for (const task of runningWorkers) lines.push(formatWorkerRow(task, now));

	const availableWorkflowLines = Math.max(0, MAX_DASHBOARD_LINES - lines.length);
	const needsOverflowLine = runningWorkflows.length > availableWorkflowLines;
	const visibleWorkflowCount = needsOverflowLine
		? Math.max(0, availableWorkflowLines - 1)
		: availableWorkflowLines;
	for (const workflow of runningWorkflows.slice(0, visibleWorkflowCount)) {
		lines.push(formatWorkflowRow(workflow, now));
	}
	const omitted = runningWorkflows.length - visibleWorkflowCount;
	if (omitted > 0) lines.push(`  … ${omitted} more running workflow(s); ask for workflow list`);
	return lines;
}
