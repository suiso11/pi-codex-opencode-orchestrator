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
	TaskMode,
	TaskSnapshot,
	TaskSpec,
	ThinkingLevel,
	ToolProfile,
	WorkflowPhaseSpec,
	WorkflowSnapshot,
} from "./types.ts";
import { taskResultText, taskResultsText, taskSummary } from "./types.ts";
import { OpenCodeWorkflowManager } from "./workflow.ts";
import { DASHBOARD_INTERVAL_MS, DASHBOARD_KEY, formatDashboard, sumWorkerUsage, type DashboardUsage } from "./dashboard.ts";
import { registerModelCommand } from "./model-command.ts";

const ModeSchema = StringEnum(["read_only", "write"] as const, {
	description: "read_only forbids changes; write permits changes only in relevant_paths.",
});

const ProfileSchema = StringEnum(["glm", "kimi_k3"] as const, {
	description: "Named worker route. Each route may use either the OpenCode or Pi backend.",
});

const ThinkingSchema = StringEnum(["low", "medium", "high"] as const, {
	description: "Per-task thinking level override. Defaults to the configured worker thinking level.",
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
	thinking: Type.Optional(ThinkingSchema),
	tool_profile: Type.Optional(ToolProfileSchema),
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

type RawTask = {
	name: string;
	mode: TaskMode;
	objective: string;
	relevant_paths: string[];
	constraints?: string[];
	expected_output: string;
	model?: string;
	profile?: ModelProfile;
	thinking?: ThinkingLevel;
	tool_profile?: ToolProfile;
};

function toTaskSpec(raw: RawTask): TaskSpec {
	return {
		name: raw.name,
		mode: raw.mode,
		objective: raw.objective,
		relevantPaths: raw.relevant_paths,
		constraints: raw.constraints ?? [],
		expectedOutput: raw.expected_output,
		model: raw.model,
		profile: raw.profile,
		thinking: raw.thinking,
		toolProfile: raw.tool_profile,
	};
}

const BATCH_DELIVERY_MAX_CHARS = 8_000;

const CORE_ORCHESTRATOR_TOOLS = ["opencode_task", "opencode_spawn", "opencode_wait", "opencode_tools"] as const;

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
	],
	control: ["opencode_cancel", "opencode_workflow_cancel"],
	workflows: [
		"opencode_workflow",
		"opencode_workflow_wait",
		"opencode_workflow_check",
		"opencode_workflow_cancel",
		"opencode_workflow_list",
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

export function compactInitialToolSet(current: readonly string[]): string[] {
	const optional = new Set<string>(OPTIONAL_ORCHESTRATOR_TOOLS);
	return unionToolNames(current, CORE_ORCHESTRATOR_TOOLS).filter((name) => !optional.has(name));
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

export default function (pi: ExtensionAPI) {
	let ui: ExtensionUIContext | undefined;
	let sessionContext: ExtensionContext | undefined;
	let tasks!: OpenCodeTaskManager;
	let workflows!: OpenCodeWorkflowManager;
	let deliverSettled = () => {};
	let deliveryScheduled = false;
	let dashboardTimer: ReturnType<typeof setInterval> | undefined;

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
			pi.setActiveTools(compactInitialToolSet(pi.getActiveTools()));
		} catch {
			// Tool-set management is best-effort; ignore if unavailable.
		}
	}

	pi.on("session_start", (_event, ctx) => {
		sessionContext = ctx;
		if (ctx.hasUI) ui = ctx.ui;
		reapplyInitialToolSet();
		updateStatus();
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
		await workflows.dispose();
		await tasks.dispose();
	});

	pi.registerTool({
		name: "opencode_spawn",
		label: "Spawn Worker",
		description:
			"Start one bounded worker through its configured OpenCode or Pi backend. Up to four workers run concurrently. Read-only workers may overlap; write workers run concurrently only when their concrete relevant_paths do not overlap.",
		promptSnippet: "Start a bounded worker in the background with read-only or path-scoped write access",
		promptGuidelines: [
			"Use opencode_spawn for independent repository exploration, mechanical implementation, tests, docs, or review; give each worker one objective and concrete relevant_paths.",
			"Keep trivial one-read or tiny one-file work with the parent; do not spawn a worker for it.",
			"Spawn independent workers together in one batch and call opencode_wait once to collect all their results.",
			"The glm and kimi_k3 profile names are routing aliases; honor their currently configured backend and model rather than assuming a specific model family.",
			"Keep final approval with the parent model; a delegated worker does not grant final approval.",
			"For parallel write opencode_spawn calls, partition relevant_paths so no file or containing directory overlaps; the extension rejects conflicting scopes.",
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
				details: { id: task.id, status: task.status, mode: task.mode, scopes: task.scopes },
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
				details: { tasks: all.map((task) => ({ id: task.id, status: task.status, mode: task.mode })) },
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
				details: { id: result.id, status: result.status },
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
		name: "opencode_tools",
		label: "OpenCode Tool Groups",
		description:
			"Activate a group of optional OpenCode orchestration tools additively for this session. Core tools (opencode_task, opencode_spawn, opencode_wait, opencode_tools) are always active. Groups: inspection (opencode_check, opencode_output, opencode_list, opencode_workflow_check, opencode_workflow_list), control (opencode_cancel, opencode_workflow_cancel), workflows (opencode_workflow, opencode_workflow_wait, opencode_workflow_check, opencode_workflow_cancel, opencode_workflow_list), all (every OpenCode tool). Activation is additive and persists for the session; call opencode_output on demand after enabling inspection/all to fetch a retained raw output slice.",
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
					`Worker thinking: ${config.thinkingLevel}`,
					`Binary: ${config.binary}`,
					`Timeout: ${config.timeoutMs} ms`,
					`Running: ${tasks.runningCount()}/${config.maxRunning}`,
					`Workflows: ${workflows.list().filter((item) => item.status === "running").length} running`,
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

	registerModelCommand(pi, tasks);
}
