import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { pruneOrchestrationResults } from "./context-pruning.ts";
import { OpenCodeTaskManager } from "./manager.ts";
import type {
	ModelProfile,
	RetainedWorktreeView,
	TaskMode,
	TaskSnapshot,
	TaskSpec,
	ThinkingLevel,
	ToolProfile,
	WorkerRole,
	WorkflowPhaseSpec,
	WorkflowSnapshot,
} from "./types.ts";
import { taskResultText, taskResultsText, taskSummary } from "./types.ts";
import { OpenCodeWorkflowManager } from "./workflow.ts";
import { buildVerifiedPhases, REQUIRE_RESOLVED_GATE } from "./verified-workflow.ts";
import { DASHBOARD_INTERVAL_MS, DASHBOARD_KEY, formatDashboard, sumWorkerUsage, type DashboardUsage } from "./dashboard.ts";
import { HerdrStatusReporter, resolveHerdrEnv } from "./herdr.ts";
import { ModelConfigSync, registerModelCommand } from "./model-command.ts";

const ModeSchema = StringEnum(["read_only", "write"] as const, {
	description: "read_only forbids changes; write permits changes only in relevant_paths.",
});

const ProfileSchema = StringEnum(["implementer", "reviewer"] as const, {
	description: "Named worker route. Each route may use either the OpenCode or Pi backend.",
});

const RoleSchema = StringEnum(["implementer", "tester", "reviewer"] as const, {
	description: "Optional explicit worker role. Tester and reviewer roles require read_only mode and receive reduced tool permissions; no role is inferred from the task name.",
});

const ThinkingSchema = StringEnum(["low", "medium", "high"] as const, {
	description: "Per-task thinking level override. Defaults to the configured worker thinking level; the reviewer role always resolves high.",
});

const ToolProfileSchema = StringEnum(["minimal", "coding", "research", "full"] as const, {
	description: "Tool capability profile for OpenCode workers. minimal=read,glob,grep; coding adds edit+bash (write mode) or is reduced to read-only tools in read_only mode; research adds webfetch+websearch; full enables every OpenCode tool. Pi workers always pass explicit --tools and ignore this field. Defaults to coding.",
});

const TaskSchema = Type.Object({
	name: Type.String({ description: "Short unique task label.", minLength: 1, maxLength: 160 }),
	mode: ModeSchema,
	objective: Type.String({ description: "One concrete, independently verifiable objective.", minLength: 1 }),
	relevant_paths: Type.Array(Type.String(), {
		description: "Concrete repository-relative files/directories. Globs and paths outside cwd are rejected.",
		minItems: 1,
		maxItems: 32,
	}),
	constraints: Type.Optional(Type.Array(Type.String(), {
		description: "Task-specific constraints and files that must not change.",
		maxItems: 32,
	})),
	expected_output: Type.String({ description: "Evidence/result the worker must return.", minLength: 1 }),
	model: Type.Optional(Type.String({ description: "Optional worker model override. Prefix with pi:: to bypass OpenCode and run through Pi." })),
	profile: Type.Optional(ProfileSchema),
	role: Type.Optional(RoleSchema),
	thinking: Type.Optional(ThinkingSchema),
	tool_profile: Type.Optional(ToolProfileSchema),
	worktree: Type.Optional(Type.Boolean({
		description: "Opt-in write isolation. Valid only for mode=write: the worker runs in a detached git worktree and changes integrate through a per-repo ID-ordered queue after the worker exits.",
	})),
	executor: Type.Optional(Type.Boolean({
		description: "Opt-in Executor MCP gateway. Requires PI_ORCH_ENABLE_EXECUTOR=1 plus the OpenCode backend with an explicit implementer role; any other combination fails before spawning.",
	})),
});

const IdsSchema = Type.Object({
	ids: Type.Array(Type.String(), { minItems: 1, maxItems: 16, description: "OpenCode task ids." }),
});

const WorkflowSchema = Type.Object({
	name: Type.String({ description: "Workflow name.", minLength: 1, maxLength: 160 }),
	phases: Type.Array(
		Type.Object({
			name: Type.String({ description: "Phase name.", minLength: 1, maxLength: 160 }),
			tasks: Type.Array(TaskSchema, { minItems: 1, maxItems: 16 }),
		}),
		{
			description: "Two or more sequential phases. Tasks inside each phase fan out with a global concurrency cap of four.",
			minItems: 2,
			maxItems: 12,
		},
	),
	background: Type.Optional(Type.Boolean({
		description: "Return immediately and deliver a follow-up when complete. Defaults to true.",
	})),
});

const VerifiedTaskSchema = Type.Object({
	name: Type.String({ description: "Short unique task label.", minLength: 1, maxLength: 160 }),
	objective: Type.String({ description: "One concrete, independently verifiable objective for the implementer phase.", minLength: 1 }),
	relevant_paths: Type.Array(Type.String(), {
		description: "Concrete repository-relative files/directories shared by all three phases. Globs and paths outside cwd are rejected.",
		minItems: 1,
		maxItems: 32,
	}),
	constraints: Type.Optional(Type.Array(Type.String(), {
		description: "Task-specific constraints applied to every phase.",
		maxItems: 32,
	})),
	expected_output: Type.String({ description: "Evidence/result the implementer must produce and the tester/reviewer verify.", minLength: 1 }),
	worktree: Type.Optional(Type.Boolean({
		description: "Opt-in write isolation for the implementer phase only: the write worker runs in a detached git worktree and changes integrate before the gated read-only phases start.",
	})),
	implementer_model: Type.Optional(Type.String({ description: "Optional model override for the implementer (write) phase." })),
	tester_model: Type.Optional(Type.String({ description: "Optional model override for the tester (read_only, gated) phase." })),
	reviewer_model: Type.Optional(Type.String({ description: "Optional model override for the reviewer (read_only, gated) phase." })),
	background: Type.Optional(Type.Boolean({
		description: "Return immediately and deliver a follow-up when complete. Defaults to true.",
	})),
});

export interface RawTask {
	name: string;
	mode: TaskMode;
	objective: string;
	relevant_paths: string[];
	constraints?: string[];
	expected_output: string;
	model?: string;
	profile?: ModelProfile;
	role?: WorkerRole;
	thinking?: ThinkingLevel;
	tool_profile?: ToolProfile;
	worktree?: boolean;
	executor?: boolean;
}

export function toTaskSpec(raw: RawTask): TaskSpec {
	return {
		name: raw.name,
		mode: raw.mode,
		objective: raw.objective,
		relevantPaths: raw.relevant_paths,
		constraints: raw.constraints ?? [],
		expectedOutput: raw.expected_output,
		model: raw.model,
		profile: raw.profile,
		role: raw.role,
		thinking: raw.thinking,
		toolProfile: raw.tool_profile,
		worktree: raw.worktree,
		executor: raw.executor,
	};
}

const BATCH_DELIVERY_MAX_CHARS = 8_000;

const CORE_ORCHESTRATOR_TOOLS = ["opencode_task", "opencode_spawn", "opencode_wait", "opencode_tools"] as const;

// Defense-in-depth coordinator-only-parent enforcement. The parent process may
// only plan, delegate, integrate, and decide; it may read the repository for
// planning but must delegate implementation and command-based testing/verification
// to workers. Safe planning reads are exact names (no bash-through-alias bypass).
const SAFE_READ_TOOLS = ["read", "grep", "find", "ls"] as const;

export const COORDINATOR_CONTRACT_HEADER = "[Coordinator-only parent contract]";

const OPTIONAL_ORCHESTRATOR_TOOLS = [
	"opencode_check",
	"opencode_output",
	"opencode_cancel",
	"opencode_list",
	"opencode_workflow",
	"opencode_workflow_wait",
	"opencode_workflow_check",
	"opencode_workflow_cancel",
	"opencode_workflow_list",
	"opencode_verified_task",
	"opencode_worktree_list",
	"opencode_worktree_status",
] as const;

const TOOL_GROUP_NAMES = ["inspection", "control", "workflows", "all"] as const;
export type ToolGroupName = (typeof TOOL_GROUP_NAMES)[number];

const TOOL_GROUPS: Record<ToolGroupName, readonly string[]> = {
	inspection: [
		"opencode_check",
		"opencode_output",
		"opencode_list",
		"opencode_workflow_check",
		"opencode_workflow_list",
		"opencode_worktree_list",
		"opencode_worktree_status",
	],
	control: ["opencode_cancel", "opencode_workflow_cancel"],
	workflows: [
		"opencode_workflow",
		"opencode_workflow_wait",
		"opencode_workflow_check",
		"opencode_workflow_cancel",
		"opencode_workflow_list",
		"opencode_verified_task",
	],
	all: [...CORE_ORCHESTRATOR_TOOLS, ...OPTIONAL_ORCHESTRATOR_TOOLS],
};

const ToolGroupSchema = StringEnum(
	TOOL_GROUP_NAMES,
	{
		description:
			"Group of OpenCode orchestration tools to activate additively. inspection adds status/output/list inspection; control adds cancellation; workflows adds phased workflow tools; all activates every OpenCode tool.",
	},
);

function unionToolNames(...lists: (readonly string[])[]): string[] {
	const set = new Set<string>();
	for (const list of lists) for (const name of list) set.add(name);
	return [...set];
}

/**
 * Strict coordinator-only-parent allowlist: safe planning reads (read/grep/find/ls)
 * plus every active `opencode_*` orchestration tool. Optional opencode groups are
 * never auto-activated; they are preserved only when already active/activated.
 * No unrelated tools (bash, edit, write, subagent, apply_patch, patch, ...) survive.
 */
export function coordinatorAllowlist(current: readonly string[]): string[] {
	const set = new Set<string>(SAFE_READ_TOOLS);
	for (const name of CORE_ORCHESTRATOR_TOOLS) set.add(name);
	for (const name of current) {
		if (name.startsWith("opencode_")) set.add(name);
	}
	return [...set];
}

/** Defense-in-depth gate shared by session_start, before_agent_start, and tool_call. */
export function isCoordinatorAllowedTool(name: string): boolean {
	if ((SAFE_READ_TOOLS as readonly string[]).includes(name)) return true;
	return name.startsWith("opencode_");
}

/** Block reason for any non-orchestration tool a coordinator-only parent must not call. */
export function coordinatorBlockReason(name: string): string {
	return `Coordinator-only parent: ${name} is not allowed here. Delegate implementation and command-based testing/verification to a worker via opencode_* orchestration tools.`;
}

/** Concise coordinator contract appended to the chained system prompt. */
export function coordinatorContractText(): string {
	return `${COORDINATOR_CONTRACT_HEADER}
- You are the coordinator-only parent: plan, delegate, integrate, and decide.
- Implementation and command-based testing/verification must be delegated to workers through opencode_* tools.
- Trivial repository reading (read, grep, find, ls) is allowed for planning.
- Never claim workers are sandboxes.`;
}

export function activateToolGroup(current: readonly string[], groupName: ToolGroupName) {
	const group = TOOL_GROUPS[groupName];
	const existing = new Set(current);
	return {
		active: unionToolNames(current, group),
		loaded: group.filter((name) => !existing.has(name)),
		alreadyActive: group.filter((name) => existing.has(name)),
	};
}

export function formatBatchDeliverable(
	readyTasks: TaskSnapshot[],
	readyWorkflows: WorkflowSnapshot[],
	workflowText: (workflow: WorkflowSnapshot) => string,
): string {
	const sections: string[] = [];
	if (readyTasks.length > 0) {
		const taskBudget = readyWorkflows.length > 0
			? Math.floor(BATCH_DELIVERY_MAX_CHARS / 2)
			: BATCH_DELIVERY_MAX_CHARS;
		sections.push(`[Background worker task(s) settled]\n${taskResultsText(readyTasks, taskBudget)}`);
	}
	if (readyWorkflows.length > 0) {
		const wfText = readyWorkflows.map((workflow) => workflowText(workflow)).join("\n\n---\n\n");
		sections.push(`[Background worker workflow(s) settled]\n${wfText}`);
	}
	const combined = sections.join("\n\n---\n\n");
	if (combined.length <= BATCH_DELIVERY_MAX_CHARS) return combined;
	const marker = "\n[Batch delivery truncated.]";
	const budget = BATCH_DELIVERY_MAX_CHARS - marker.length;
	if (budget <= 0) return combined.slice(0, BATCH_DELIVERY_MAX_CHARS);
	return `${combined.slice(0, budget)}${marker}`;
}

export function boundParentText(value: string, maxChars = BATCH_DELIVERY_MAX_CHARS) {
	if (value.length <= maxChars) return value;
	if (maxChars <= 0) return "";
	const marker = "\n[Parent-facing output truncated.]";
	if (marker.length >= maxChars) return value.slice(0, maxChars);
	return `${value.slice(0, maxChars - marker.length)}${marker}`;
}

export function shouldDelayBackgroundDelivery(tasks: TaskSnapshot[], workflows: WorkflowSnapshot[]) {
	return tasks.some((task) => task.status === "running" && !task.workflowId) ||
		workflows.some((workflow) => workflow.status === "running");
}

export function formatRawOutputSlice(output: string, requestedOffset?: number, requestedLimit = 8_000) {
	const total = output.length;
	const limit = Math.min(Math.max(1, requestedLimit), 12_000);
	const defaultOffset = Math.max(0, total - 8_000);
	const offset = Math.min(Math.max(0, requestedOffset ?? defaultOffset), total);
	let slice = output.slice(offset, offset + limit);
	while (slice.length > 0) {
		const end = offset + slice.length;
		const moreFollows = end < total;
		const header = `[Raw output ${offset}:${end} of ${total}]${moreFollows ? " (more follows)" : ""}`;
		if (header.length + 1 + slice.length <= limit) break;
		const overflow = header.length + 1 + slice.length - limit;
		slice = slice.slice(0, Math.max(0, slice.length - Math.max(1, overflow)));
	}
	const end = offset + slice.length;
	const moreFollows = end < total;
	const header = `[Raw output ${offset}:${end} of ${total}]${moreFollows ? " (more follows)" : ""}`;
	const text = `${header}
${slice || "(empty)"}`.slice(0, limit);
	return { text, offset, end, total, limit, moreFollows };
}

/**
 * Read-only manager surface used by the worktree cleanup command and the
 * opencode_worktree_* inspection tools. It exposes only the serializable
 * RetainedWorktreeView (no absolute OS-temp paths) and never mutates.
 */
export interface RetainedWorktreeManagerLike {
	listRetainedWorktrees(): RetainedWorktreeView[];
	getRetainedWorktree(taskId: string): RetainedWorktreeView;
	retryRetainedWorktree(taskId: string): RetainedWorktreeView;
	discardRetainedWorktree(taskId: string): RetainedWorktreeView;
}

/** Minimal UI context the worktree command relies on (mirrors ExtensionUIContext). */
export interface WorktreeCommandCtx {
	hasUI?: boolean;
	ui?: {
		notify?: (message: string, type?: "info" | "warning" | "error") => void;
		confirm?: (title: string, message: string) => Promise<boolean> | boolean;
		select?: (title: string, options: string[]) => Promise<string | undefined> | string | undefined;
	};
}

/** Concise one-line-per-entry summary. Uses only safe, serializable view fields. */
export function formatRetainedWorktreeList(views: RetainedWorktreeView[]): string {
	if (views.length === 0) return "No retained worktrees.";
	return views.map((view) =>
		`${view.taskId} [${view.status}] "${view.name}" repo=${view.repo} kind=${view.kind}${view.retryable ? " retryable" : ""}${view.error ? " error" : ""}`,
	).join("\n");
}

/** Redacted multi-line detail view. Never includes an absolute temp path. */
export function formatRetainedWorktreeDetail(view: RetainedWorktreeView): string {
	const lines = [
		`Task: ${view.taskId} "${view.name}"`,
		`Status: ${view.status}`,
		`Repository: ${view.repo}`,
		`Base head: ${view.baseHead}`,
		`Retention kind: ${view.kind}`,
		`Retryable: ${view.retryable}`,
		`Root integrated: ${view.rootIntegrated}`,
		`Patch available: ${view.patchAvailable}`,
	];
	if (view.scopes.length > 0) lines.push(`Scopes: ${view.scopes.join(", ")}`);
	if (view.changedPaths.length > 0) lines.push(`Changed paths: ${view.changedPaths.join(", ")}`);
	if (view.conflictPaths.length > 0) lines.push(`Conflict paths: ${view.conflictPaths.join(", ")}`);
	if (view.error) lines.push(`Error: ${view.error}`);
	return lines.join("\n");
}

/** Human outcome of a retry/discard mutation, derived from the returned view. */
export function describeWorktreeMutationOutcome(action: "retry" | "discard", view: RetainedWorktreeView): string {
	if (action === "retry") {
		if (view.rootIntegrated && !view.error) return `Integrated retained worktree for task ${view.taskId}.`;
		if (view.error) return `Integrated, but cleanup failed for task ${view.taskId}; entry retained: ${view.error}`;
		return `Retry did not integrate; entry retained for task ${view.taskId}.`;
	}
	if (!view.error) return `Discarded retained worktree for task ${view.taskId}.`;
	return `Cleanup failed for task ${view.taskId}; entry retained: ${view.error}`;
}

function worktreeNotify(ctx: WorktreeCommandCtx, message: string, level: "info" | "warning" | "error" = "info") {
	ctx.ui?.notify?.(message, level);
}

function worktreeUsage(ctx: WorktreeCommandCtx, message: string) {
	worktreeNotify(ctx, message, "error");
}

/**
 * `/opencode-worktrees` handler. `list` (or no args) shows retained entries
 * (using ctx.ui.select when available); `status`/`inspect <id>` shows a redacted
 * detail; `retry <id>` and `discard <id>` are mutation-only subcommands that
 * require an interactive UI plus an explicit confirmation and are otherwise
 * rejected with guidance. No `--yes` bypass exists: every mutation confirms.
 */
export async function handleWorktreeCommand(
	manager: RetainedWorktreeManagerLike,
	rawArgs: string,
	ctx: WorktreeCommandCtx,
): Promise<void> {
	const args = rawArgs.trim().split(/\s+/).filter(Boolean);
	const sub = args[0]?.toLowerCase();
	const id = args[1];

	// No args / `list`: show retained entries. In a TUI, let the user pick an
	// entry then an action; this is purely additive and never mutates directly.
	if (sub === undefined || sub === "list") {
		const views = manager.listRetainedWorktrees();
		if (views.length > 0 && ctx.hasUI && ctx.ui?.select) {
			const picked = await ctx.ui.select("Retained worktrees", views.map((view) => view.taskId));
			if (!picked) {
				worktreeNotify(ctx, "Cancelled.");
				return;
			}
			const action = await ctx.ui.select(`Action for ${picked}`, ["inspect", "retry", "discard", "cancel"]);
			if (!action || action === "cancel") {
				worktreeNotify(ctx, "Cancelled.");
				return;
			}
			if (action === "inspect") return handleWorktreeCommand(manager, `status ${picked}`, ctx);
			if (action === "retry") return handleWorktreeCommand(manager, `retry ${picked}`, ctx);
			if (action === "discard") return handleWorktreeCommand(manager, `discard ${picked}`, ctx);
			return;
		}
		worktreeNotify(ctx, formatRetainedWorktreeList(views));
		return;
	}

	if (sub === "status" || sub === "inspect") {
		if (!id) {
			worktreeUsage(ctx, "Usage: /opencode-worktrees status <task-id>");
			return;
		}
		let view: RetainedWorktreeView;
		try {
			view = manager.getRetainedWorktree(id);
		} catch (error) {
			worktreeUsage(ctx, `No retained worktree for task ${id}: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		worktreeNotify(ctx, formatRetainedWorktreeDetail(view));
		return;
	}

	if (sub === "retry" || sub === "discard") {
		if (!id) {
			worktreeUsage(ctx, `Usage: /opencode-worktrees ${sub} <task-id>`);
			return;
		}
		if (!ctx.hasUI || !ctx.ui?.confirm) {
			worktreeUsage(
				ctx,
				`${sub} requires an interactive UI with explicit confirmation; cannot run "${sub} ${id}". Use "list" or "status <id>" to inspect retained worktrees; there is no non-interactive bypass.`,
			);
			return;
		}
		const confirmMessage = sub === "retry"
			? `Retry integrating the retained worktree for task ${id}? This applies the previously validated patch at the repository root.`
			: `Discard the retained worktree for task ${id}? This permanently removes the isolated worktree and its patch (destructive, cannot be undone).`;
		if (!(await ctx.ui.confirm("Confirm worktree action", confirmMessage))) {
			worktreeNotify(ctx, `Cancelled ${sub} for task ${id}.`);
			return;
		}
		let view: RetainedWorktreeView;
		try {
			view = sub === "retry" ? manager.retryRetainedWorktree(id) : manager.discardRetainedWorktree(id);
		} catch (error) {
			worktreeUsage(
				ctx,
				`${sub} failed for task ${id}; entry retained: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		worktreeNotify(ctx, describeWorktreeMutationOutcome(sub, view));
		return;
	}

	worktreeUsage(
		ctx,
		`Unknown subcommand "${sub}". Usage: /opencode-worktrees [list | status <id> | inspect <id> | retry <id> | discard <id>]`,
	);
}

export default function (pi: ExtensionAPI) {
	let ui: ExtensionUIContext | undefined;
	let sessionContext: ExtensionContext | undefined;
	let tasks!: OpenCodeTaskManager;
	let workflows!: OpenCodeWorkflowManager;
	let deliverSettled = () => {};
	let deliveryScheduled = false;
	let dashboardTimer: ReturnType<typeof setInterval> | undefined;

	// Optional Herdr status integration: a complete no-op unless the orchestrator
	// runs inside a Herdr pane (HERDR_ENV=1, HERDR_PANE_ID, HERDR_BIN_PATH all set).
	// Failures never propagate; they stay in the reporter's bounded diagnostics.
	const herdrEnv = resolveHerdrEnv();
	const herdr = herdrEnv ? new HerdrStatusReporter({ env: herdrEnv }) : undefined;

	const parentUsage = {
		inputTokens: 0,
		outputTokens: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 0,
		cost: 0,
	};

	let latestPruningStats = {
		prunedMessages: 0,
		charsRemoved: 0,
	};

	const dashboardUsage = (): DashboardUsage => ({
		parent: {
			inputTokens: parentUsage.inputTokens,
			outputTokens: parentUsage.outputTokens,
			totalTokens: parentUsage.totalTokens,
			cost: parentUsage.cost,
		},
	});

	const updateDashboard = () => {
		if (!ui) return;
		ui.setWidget(
			DASHBOARD_KEY,
			formatDashboard(tasks.list(), workflows.list(), Date.now(), dashboardUsage()),
			{ placement: "aboveEditor" },
		);
	};

	const syncDashboardTimer = (hasRunningWork: boolean) => {
		if (hasRunningWork && !dashboardTimer) {
			dashboardTimer = setInterval(updateDashboard, DASHBOARD_INTERVAL_MS);
			dashboardTimer.unref();
		} else if (!hasRunningWork && dashboardTimer) {
			clearInterval(dashboardTimer);
			dashboardTimer = undefined;
		}
	};

	const updateStatus = () => {
		const taskRunning = tasks?.runningCount() ?? 0;
		const workflowRunning = workflows?.list().filter((item) => item.status === "running").length ?? 0;
		try {
			herdr?.report(tasks.list(), workflows.list());
		} catch {
			// Herdr reporting is best-effort only; never fail orchestration for it.
		}
		if (ui) {
			const hasRunningWork = taskRunning > 0 || workflowRunning > 0;
			if (!hasRunningWork) ui.setStatus("opencode-orchestrator", undefined);
			else ui.setStatus("opencode-orchestrator", `Workers ${taskRunning}/4 · workflows ${workflowRunning}`);
			syncDashboardTimer(hasRunningWork);
			updateDashboard();
		}
		if (sessionContext?.isIdle() && !deliveryScheduled) {
			deliveryScheduled = true;
			queueMicrotask(() => {
				deliveryScheduled = false;
				deliverSettled();
			});
		}
	};

	tasks = new OpenCodeTaskManager({ onChange: updateStatus });
	workflows = new OpenCodeWorkflowManager(tasks, { onChange: updateStatus });

	const modelSync = new ModelConfigSync(pi, tasks);

	deliverSettled = () => {
		const taskList = tasks.list();
		const workflowList = workflows.list();
		const hasRunningBackground = shouldDelayBackgroundDelivery(taskList, workflowList);
		const readyTasks = hasRunningBackground ? [] : tasks.drainDeliverable();
		const readyWorkflows = hasRunningBackground ? [] : workflows.drainDeliverable();
		if (readyTasks.length === 0 && readyWorkflows.length === 0) return;
		const content = formatBatchDeliverable(readyTasks, readyWorkflows, (workflow) => workflows.resultText(workflow));
		pi.sendMessage(
			{
				customType: "opencode-batch-result",
				content,
				display: true,
				details: {
					tasks: readyTasks.map((task) => ({ id: task.id, status: task.status, mode: task.mode })),
					workflows: readyWorkflows.map((workflow) => ({ id: workflow.id, status: workflow.status })),
				},
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};

	function reapplyInitialToolSet() {
		try {
			pi.setActiveTools(coordinatorAllowlist(pi.getActiveTools()));
		} catch {
			// Tool-set management is best-effort; ignore if unavailable.
		}
	}

	pi.on("session_start", (_event, ctx) => {
		sessionContext = ctx;
		if (ctx.hasUI) ui = ctx.ui;
		reapplyInitialToolSet();
		updateStatus();
		modelSync.start(ctx);
	});

	// Defense-in-depth: block every tool call that is not a safe planning read or an
	// opencode_* orchestration tool. This prevents other extensions/presets from
	// bypassing the coordinator-only-parent enforcement via setActiveTools.
	pi.on("tool_call", (event) => {
		if (isCoordinatorAllowedTool(event.toolName)) return undefined;
		return { block: true, reason: coordinatorBlockReason(event.toolName) };
	});

	// Intercept user `!` / `!!` shell commands: a coordinator-only parent never runs
	// commands; command-based testing/verification must be delegated to a worker.
	pi.on("user_bash", () => ({
		result: {
			output:
				"Cancelled: the coordinator-only parent does not run commands. Delegate command-based testing/verification to a worker.",
			exitCode: 1,
			cancelled: true,
			truncated: false,
		},
	}));

	// Re-apply the strict allowlist each turn and append the coordinator contract to
	// the chained system prompt (idempotent so repeated turns do not stack it).
	pi.on("before_agent_start", (event) => {
		reapplyInitialToolSet();
		if (event.systemPrompt.includes(COORDINATOR_CONTRACT_HEADER)) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${coordinatorContractText()}` };
	});
	pi.on("context", (event) => {
		if (!event.messages || event.messages.length === 0) return;
		const result = pruneOrchestrationResults(event.messages);
		latestPruningStats = {
			prunedMessages: result.prunedMessages,
			charsRemoved: result.charsRemoved,
		};
		if (result.prunedMessages === 0) return;
		return { messages: result.messages };
	});
	pi.on("agent_settled", deliverSettled);
	pi.on("message_end", (event) => {
		const message = event.message;
		if (!message || message.role !== "assistant") return;
		const usage = message.usage;
		if (!usage) return;
		parentUsage.inputTokens += usage.input ?? 0;
		parentUsage.outputTokens += usage.output ?? 0;
		parentUsage.cacheRead += usage.cacheRead ?? 0;
		parentUsage.cacheWrite += usage.cacheWrite ?? 0;
		parentUsage.reasoning += usage.reasoning ?? 0;
		parentUsage.totalTokens += usage.totalTokens ?? 0;
		parentUsage.cost += usage.cost?.total ?? 0;
	});
	pi.on("session_shutdown", async () => {
		sessionContext = undefined;
		if (dashboardTimer) clearInterval(dashboardTimer);
		dashboardTimer = undefined;
		ui?.setStatus("opencode-orchestrator", undefined);
		ui?.setWidget(DASHBOARD_KEY, undefined);
		ui = undefined;
		modelSync.close();
		try {
			herdr?.release();
			// Wait for the release (and any in-flight report) subprocess to settle
			// so the final status is reliably delivered before the process exits.
			await herdr?.flush();
		} catch {
			// Release is best-effort; never fail shutdown for it.
		}
		await workflows.dispose();
		await tasks.dispose();
	});

	pi.registerTool({
		name: "opencode_spawn",
		label: "Spawn Worker",
		description:
			"Start one bounded worker through its configured OpenCode or Pi backend. Up to four workers run concurrently. Read-only workers may overlap; write workers run concurrently only when every concurrently running write opts into worktree isolation (worktree=true) and their concrete relevant_paths do not overlap.",
		promptSnippet: "Start a bounded worker in the background with read-only or path-scoped write access",
		promptGuidelines: [
			"Use opencode_spawn for independent repository exploration, mechanical implementation, tests, docs, or review; give each worker one objective and concrete relevant_paths.",
			"Keep trivial one-read or tiny one-file work with the parent; do not spawn a worker for it.",
			"Spawn independent workers together in one batch and call opencode_wait once to collect all their results.",
			"The implementer and reviewer profile names are routing aliases; honor their currently configured backend and model rather than assuming a specific model family.",
			"An explicit role is never inferred from the task name. Tester and reviewer roles require read_only mode: tester keeps bash for running verification commands behind a repository mutation guard, and reviewer gets no bash.",
			"Keep final approval with the parent model; a delegated worker does not grant final approval.",
			"Only one non-worktree write may run at a time. For parallel writes, set worktree=true on every concurrent write task and partition relevant_paths so no file or containing directory overlaps; the extension rejects conflicting scopes and non-isolated concurrent writes.",
			"Worktree writes need a clean Git root for the first task of a batch; later worktree tasks in the same batch share that base and must be spawned before the batch settles.",
			"After opencode_spawn, continue useful orchestration work, then call opencode_wait before relying on worker results.",
		],
		parameters: TaskSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = tasks.spawn(toTaskSpec(params), ctx.cwd);
			return {
				content: [{
					type: "text",
					text: boundParentText(`Started ${taskSummary(task)}\nScopes: ${task.relevantPaths.join(", ")}`),
				}],
				details: { id: task.id, status: task.status, mode: task.mode, role: task.role, scopes: task.scopes, worktree: task.worktree?.status },
			};
		},
	});

	pi.registerTool({
		name: "opencode_wait",
		label: "Wait for OpenCode Workers",
		description: "Wait for one or more background OpenCode workers and return their results. Aborting the wait leaves workers running.",
		promptSnippet: "Wait for background OpenCode workers and collect their results",
		parameters: IdsSchema,
		async execute(_toolCallId, params, signal, onUpdate) {
			onUpdate?.({
				content: [{ type: "text", text: `Waiting for ${params.ids.join(", ")}...` }],
				details: { ids: params.ids, pending: true },
			});
			const results = await tasks.wait(params.ids, signal, true);
			return {
				content: [{ type: "text", text: taskResultsText(results) }],
				details: { results: results.map((task) => ({ id: task.id, status: task.status })) },
			};
		},
	});

	pi.registerTool({
		name: "opencode_check",
		label: "Check OpenCode Worker",
		description: "Inspect one worker's status, recent activity, and current output preview without waiting.",
		parameters: Type.Object({ id: Type.String({ description: "OpenCode task id." }) }),
		async execute(_toolCallId, params) {
			const task = tasks.get(params.id);
			if (!task) throw new Error(`Unknown OpenCode task id: ${params.id}`);
			const preview = task.output.slice(-2_000);
			return {
				content: [{
					type: "text",
					text: boundParentText(`${taskSummary(task)}\nActivity:\n${task.activity.slice(-10).join("\n") || "(none)"}\n\nOutput preview:\n${preview || "(none)"}`),
				}],
				details: { id: task.id, status: task.status, activity: task.activity },
			};
		},
	});

	pi.registerTool({
		name: "opencode_output",
		label: "Fetch OpenCode Worker Output",
		description:
			"Fetch a retained raw output slice from one OpenCode worker on demand. Use when the opencode_check preview is insufficient; this fetch is explicitly on-demand and does not wait.",
		parameters: Type.Object({
			id: Type.String({ description: "OpenCode task id." }),
			offset: Type.Optional(Type.Integer({
				description: "Character offset into retained output. Defaults to the last 8000 characters.",
				minimum: 0,
			})),
			limit: Type.Optional(Type.Integer({
				description: "Maximum characters to return.",
				minimum: 1,
				maximum: 12_000,
			})),
		}),
		async execute(_toolCallId, params) {
			const task = tasks.get(params.id);
			if (!task) throw new Error(`Unknown OpenCode task id: ${params.id}`);
			const result = formatRawOutputSlice(task.output, params.offset, params.limit);
			const { text, ...details } = result;
			return {
				content: [{ type: "text", text }],
				details: { id: task.id, status: task.status, ...details },
			};
		},
	});

	pi.registerTool({
		name: "opencode_cancel",
		label: "Cancel OpenCode Workers",
		description: "Cancel one or more OpenCode workers and wait for their processes to settle.",
		parameters: IdsSchema,
		async execute(_toolCallId, params) {
			const results = await tasks.cancel(params.ids);
			return {
				content: [{ type: "text", text: taskResultsText(results) }],
				details: { results: results.map((task) => ({ id: task.id, status: task.status })) },
			};
		},
	});

	pi.registerTool({
		name: "opencode_list",
		label: "List OpenCode Workers",
		description: "List tracked OpenCode workers and their current states.",
		parameters: Type.Object({}),
		async execute() {
			const all = tasks.list();
			return {
				content: [{ type: "text", text: boundParentText(all.length ? all.map(taskSummary).join("\n") : "No OpenCode workers.") }],
				details: { tasks: all.map((task) => ({ id: task.id, status: task.status, mode: task.mode, worktree: task.worktree?.status })) },
			};
		},
	});

	pi.registerTool({
		name: "opencode_task",
		label: "Run OpenCode Task",
		description: "Run one bounded OpenCode task and wait for it. Prefer opencode_spawn for work that can overlap with other orchestration.",
		promptSnippet: "Run one bounded OpenCode task synchronously",
		parameters: TaskSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const task = tasks.spawn(toTaskSpec(params), ctx.cwd);
			onUpdate?.({
				content: [{ type: "text", text: `Running ${task.id}...` }],
				details: { id: task.id, status: task.status },
			});
			const [result] = await tasks.wait([task.id], signal, true);
			return {
				content: [{ type: "text", text: taskResultText(result) }],
				details: { id: result.id, status: result.status, role: result.role, worktree: result.worktree?.status },
			};
		},
	});

	pi.registerTool({
		name: "opencode_workflow",
		label: "Run OpenCode Workflow",
		description:
			"Run a complex OpenCode workflow with at least two dependent phases. Phases run sequentially; tasks within a phase fan out up to the global four-worker cap. Use only when a task genuinely needs phased fan-out and synthesis, not for one small delegation.",
		parameters: WorkflowSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const phases: WorkflowPhaseSpec[] = params.phases.map((phase) => ({
				name: phase.name,
				tasks: phase.tasks.map((task) => toTaskSpec(task)),
			}));
			const workflow = workflows.start(params.name, phases, ctx.cwd);
			if (params.background ?? true) {
				return {
					content: [{ type: "text", text: `Started background workflow ${workflow.id} "${workflow.name}" with ${workflow.phases.length} phases.` }],
					details: { id: workflow.id, status: workflow.status, background: true },
				};
			}
			onUpdate?.({
				content: [{ type: "text", text: `Running workflow ${workflow.id}...` }],
				details: { id: workflow.id, status: workflow.status, background: false },
			});
			const result = await workflows.wait(workflow.id, signal, true);
			return {
				content: [{ type: "text", text: workflows.resultText(result) }],
				details: { id: result.id, status: result.status, background: false },
			};
		},
	});

	pi.registerTool({
		name: "opencode_workflow_wait",
		label: "Wait for OpenCode Workflow",
		description: "Wait for a background phased workflow and return all task results.",
		parameters: Type.Object({ id: Type.String({ description: "OpenCode workflow id." }) }),
		async execute(_toolCallId, params, signal, onUpdate) {
			onUpdate?.({
				content: [{ type: "text", text: `Waiting for workflow ${params.id}...` }],
				details: { id: params.id, pending: true },
			});
			const result = await workflows.wait(params.id, signal, true);
			return {
				content: [{ type: "text", text: workflows.resultText(result) }],
				details: { id: result.id, status: result.status },
			};
		},
	});

	pi.registerTool({
		name: "opencode_workflow_check",
		label: "Check OpenCode Workflow",
		description: "Inspect a phased workflow without waiting.",
		parameters: Type.Object({ id: Type.String({ description: "OpenCode workflow id." }) }),
		async execute(_toolCallId, params) {
			const workflow = workflows.get(params.id);
			if (!workflow) throw new Error(`Unknown OpenCode workflow id: ${params.id}`);
			return {
				content: [{ type: "text", text: workflows.resultText(workflow) }],
				details: { id: workflow.id, status: workflow.status, currentPhase: workflow.currentPhase },
			};
		},
	});

	pi.registerTool({
		name: "opencode_workflow_cancel",
		label: "Cancel OpenCode Workflow",
		description: "Cancel a phased workflow and all currently running workers owned by it.",
		parameters: Type.Object({ id: Type.String({ description: "OpenCode workflow id." }) }),
		async execute(_toolCallId, params) {
			const workflow = await workflows.cancel(params.id);
			return {
				content: [{ type: "text", text: workflows.resultText(workflow) }],
				details: { id: workflow.id, status: workflow.status },
			};
		},
	});

	pi.registerTool({
		name: "opencode_workflow_list",
		label: "List OpenCode Workflows",
		description: "List tracked phased workflows.",
		parameters: Type.Object({}),
		async execute() {
			const all = workflows.list();
			return {
				content: [{
					type: "text",
					text: boundParentText(all.length
						? all.map((workflow) => `${workflow.id} [${workflow.status}] "${workflow.name}" phase ${workflow.currentPhase === undefined ? "-" : workflow.currentPhase + 1}/${workflow.phases.length}`).join("\n")
						: "No OpenCode workflows."),
				}],
				details: { workflows: all.map((workflow) => ({ id: workflow.id, status: workflow.status })) },
			};
		},
	});

	pi.registerTool({
		name: "opencode_verified_task",
		label: "Run Verified Task Workflow",
		description:
			"Run one objective through a standard three-phase verification loop: implementer (write) -> tester (read_only) -> reviewer (read_only). The tester and reviewer phases carry the internal requireResolved quality gate: even when a gate worker finishes with status=done, a non-empty report.unresolved fails the workflow (status=error) and the next phase never starts. A tester/reviewer worker error stops the workflow through the existing failure path. There is no automatic retry and no infinite loop. Final approval always stays with the parent: a done workflow is verification evidence only, never an approval.",
		promptSnippet: "Run one objective through the gated implement-test-review verification workflow",
		promptGuidelines: [
			"Use opencode_verified_task when one objective should be implemented, tested, and reviewed before you inspect the result yourself.",
			"The requireResolved gate blocks progression when the tester or reviewer reports unresolved issues; address them by calling the tool again with a refined objective — nothing is retried automatically.",
			"Final approval is never delegated: a completed workflow is evidence, and you as the parent must still inspect the diff and decide.",
		],
		parameters: VerifiedTaskSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const phases = buildVerifiedPhases({
				name: params.name,
				objective: params.objective,
				relevantPaths: params.relevant_paths,
				constraints: params.constraints,
				expectedOutput: params.expected_output,
				worktree: params.worktree,
				implementerModel: params.implementer_model,
				testerModel: params.tester_model,
				reviewerModel: params.reviewer_model,
			});
			const workflow = workflows.start(`verified: ${params.name}`, phases, ctx.cwd);
			if (params.background ?? true) {
				return {
					content: [{
						type: "text",
						text: `Started verified workflow ${workflow.id} "${workflow.name}" (implement -> test -> review, requireResolved gate on test/review). Final approval stays with the parent.`,
					}],
					details: { id: workflow.id, status: workflow.status, gate: REQUIRE_RESOLVED_GATE, background: true },
				};
			}
			onUpdate?.({
				content: [{ type: "text", text: `Running verified workflow ${workflow.id}...` }],
				details: { id: workflow.id, status: workflow.status, gate: REQUIRE_RESOLVED_GATE, background: false },
			});
			const result = await workflows.wait(workflow.id, signal, true);
			return {
				content: [{
					type: "text",
					text: `${workflows.resultText(result)}\nFinal approval stays with the parent; a done workflow is verification evidence only.`,
				}],
				details: { id: result.id, status: result.status, gate: REQUIRE_RESOLVED_GATE, background: false },
			};
		},
	});

	pi.registerTool({
		name: "opencode_worktree_list",
		label: "List Retained Worktrees",
		description: "List retained (never auto-deleted) worktree isolation entries that failed integration or cleanup and await a decision. Read-only: no mutation or absolute path is exposed.",
		parameters: Type.Object({}),
		async execute() {
			const views = tasks.listRetainedWorktrees();
			return {
				content: [{ type: "text", text: boundParentText(formatRetainedWorktreeList(views)) }],
				details: { retained: views },
			};
		},
	});

	pi.registerTool({
		name: "opencode_worktree_status",
		label: "Inspect Retained Worktree",
		description: "Inspect one retained worktree isolation entry without modifying it. Read-only: no retry/discard and no absolute path is exposed.",
		parameters: Type.Object({ id: Type.String({ description: "Retained worktree task id." }) }),
		async execute(_toolCallId, params) {
			const view = tasks.getRetainedWorktree(params.id);
			return {
				content: [{ type: "text", text: boundParentText(formatRetainedWorktreeDetail(view)) }],
				details: view,
			};
		},
	});

	pi.registerTool({
		name: "opencode_tools",
		label: "OpenCode Tool Groups",
		description:
			"Activate a group of optional OpenCode orchestration tools additively for this session. Core tools (opencode_task, opencode_spawn, opencode_wait, opencode_tools) are always active. Groups: inspection (opencode_check, opencode_output, opencode_list, opencode_workflow_check, opencode_workflow_list, opencode_worktree_list, opencode_worktree_status), control (opencode_cancel, opencode_workflow_cancel), workflows (opencode_workflow, opencode_workflow_wait, opencode_workflow_check, opencode_workflow_cancel, opencode_workflow_list, opencode_verified_task), all (every OpenCode tool). Activation is additive and persists for the session; call opencode_output on demand after enabling inspection/all to fetch a retained raw output slice.",
		promptSnippet: "Activate a group of optional OpenCode orchestration tools for this session",
		parameters: Type.Object({ group: ToolGroupSchema }),
		async execute(_toolCallId, params) {
			const activation = activateToolGroup(pi.getActiveTools(), params.group);
			pi.setActiveTools(activation.active);
			return {
				content: [{
					type: "text",
					text: boundParentText(
						`Tool group "${params.group}" active. Loaded: ${activation.loaded.join(", ") || "(none)"}; already active: ${activation.alreadyActive.join(", ") || "(none)"}.`,
					),
				}],
				details: { group: params.group, loaded: activation.loaded, alreadyActive: activation.alreadyActive },
			};
		},
	});

	pi.registerCommand("opencode-status", {
		description: "Show worker routing configuration and active work",
		handler: async (_args, ctx) => {
			const config = tasks.configuration();
			ctx.ui.notify(
				[
					`Default worker route: ${config.model}`,
					`Profiles: ${Object.entries(config.profiles).map(([name, model]) => `${name}=${model}`).join(", ")}`,
					`Tester profile: ${config.testerProfile}`,
					`Worker thinking: ${config.thinkingLevel}`,
					`Binary: ${config.binary}`,
					`Timeout: ${config.timeoutMs} ms`,
					`Running: ${tasks.runningCount()}/${config.maxRunning}`,
					`Workflows: ${workflows.list().filter((item) => item.status === "running").length} running`,
					`Herdr: ${herdr
						? `enabled (state ${herdr.lastStatus?.state ?? "-"}, reports ${herdr.reportsCount}${herdr.diagnostics.length > 0 ? `, diagnostics: ${herdr.diagnostics.join("; ")}` : ""})`
						: "disabled (not inside a Herdr pane)"}`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("opencode-usage", {
		description: "Report parent and worker token usage plus workflow handoff duplication",
		handler: async (_args, ctx) => {
			const worker = sumWorkerUsage(tasks.list());
			const workflowList = workflows.list();
			let handoffCreated = 0;
			let handoffInjected = 0;
			for (const workflow of workflowList) {
				handoffCreated += workflow.handoffCharsCreated ?? 0;
				handoffInjected += workflow.handoffCharsInjected ?? 0;
			}
			const duplicationRatio = handoffInjected > 0
				? Math.max(0, (handoffInjected - handoffCreated) / handoffInjected)
				: 0;
			ctx.ui.notify(
				[
					`Parent tokens: in ${parentUsage.inputTokens.toLocaleString()} / out ${parentUsage.outputTokens.toLocaleString()} / total ${parentUsage.totalTokens.toLocaleString()} / cost ${parentUsage.cost.toFixed(6)}`,
					`Worker tokens: in ${worker.inputTokens.toLocaleString()} / out ${worker.outputTokens.toLocaleString()} / total ${worker.totalTokens.toLocaleString()} / cost ${worker.cost.toFixed(6)}`,
					`Workflow handoff: ${handoffCreated.toLocaleString()} unique chars created, ${handoffInjected.toLocaleString()} chars injected downstream (duplication ratio ${duplicationRatio.toFixed(2)})`,
					`Current context pruning: ${latestPruningStats.prunedMessages.toLocaleString()} messages, ${latestPruningStats.charsRemoved.toLocaleString()} chars removed from this model request`,
					`Totals are observed usage; no baseline comparison is available, so token savings are not claimed.`,
				].join("\n"),
				"info",
			);
		},
	});

	registerModelCommand(pi, tasks, modelSync);

	pi.registerCommand("opencode-worktrees", {
		description: "Inspect and clean up retained worktree isolation entries. list/status are read-only; retry/discard require interactive UI confirmation",
		handler: async (args, ctx) => {
			await handleWorktreeCommand(tasks, args, ctx);
		},
	});
}
