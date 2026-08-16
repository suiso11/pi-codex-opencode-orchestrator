import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { OpenCodeTaskManager } from "./manager.ts";
import type { ModelProfile, TaskMode, TaskSpec, WorkflowPhaseSpec } from "./types.ts";
import { taskResultText, taskResultsText, taskSummary } from "./types.ts";
import { OpenCodeWorkflowManager } from "./workflow.ts";
import { DASHBOARD_INTERVAL_MS, DASHBOARD_KEY, formatDashboard } from "./dashboard.ts";
import { registerModelCommand } from "./model-command.ts";

const ModeSchema = StringEnum(["read_only", "write"] as const, {
	description: "read_only forbids changes; write permits changes only in relevant_paths.",
});

const ProfileSchema = StringEnum(["glm", "kimi_k3"] as const, {
	description: "Named worker route. Each route may use either the OpenCode or Pi backend.",
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
	};
}

export default function (pi: ExtensionAPI) {
	let ui: ExtensionUIContext | undefined;
	let sessionContext: ExtensionContext | undefined;
	let tasks!: OpenCodeTaskManager;
	let workflows!: OpenCodeWorkflowManager;
	let deliverSettled = () => {};
	let deliveryScheduled = false;
	let dashboardTimer: ReturnType<typeof setInterval> | undefined;

	const updateDashboard = () => {
		if (!ui) return;
		ui.setWidget(
			DASHBOARD_KEY,
			formatDashboard(tasks.list(), workflows.list(), Date.now()),
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
		for (const task of tasks.drainDeliverable()) {
			pi.sendMessage(
				{
					customType: "opencode-task-result",
					content: `[Background worker task settled]\n\n${taskResultText(task)}`,
					display: true,
					details: { id: task.id, status: task.status, mode: task.mode },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}
		for (const workflow of workflows.drainDeliverable()) {
			pi.sendMessage(
				{
					customType: "opencode-workflow-result",
					content: `[Background worker workflow settled]\n\n${workflows.resultText(workflow)}`,
					display: true,
					details: { id: workflow.id, status: workflow.status },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}
	};

	pi.on("session_start", (_event, ctx) => {
		sessionContext = ctx;
		if (ctx.hasUI) ui = ctx.ui;
		updateStatus();
	});
	pi.on("agent_settled", deliverSettled);
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
					text: `Started ${taskSummary(task)}\nScopes: ${task.relevantPaths.join(", ")}`,
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
			const preview = task.output.slice(-4_000);
			return {
				content: [{
					type: "text",
					text: `${taskSummary(task)}\nActivity:\n${task.activity.slice(-10).join("\n") || "(none)"}\n\nOutput preview:\n${preview || "(none)"}`,
				}],
				details: { id: task.id, status: task.status, activity: task.activity },
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
				content: [{ type: "text", text: all.length ? all.map(taskSummary).join("\n") : "No OpenCode workers." }],
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
		promptSnippet: "Run a complex two-or-more-phase OpenCode workflow with bounded parallel fan-out",
		promptGuidelines: [
			"Use opencode_workflow only for complex work with at least two dependent phases or three independent subtasks; use opencode_task/opencode_spawn for simpler work.",
			"The glm and kimi_k3 profile names are configurable routing aliases and may use either OpenCode or Pi.",
			"After the workflow, keep final approval with the parent; do not treat worker output as final approval.",
			"Within an opencode_workflow phase, give write tasks non-overlapping relevant_paths; overlapping write scopes are rejected before the workflow starts.",
		],
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
					text: all.length
						? all.map((workflow) => `${workflow.id} [${workflow.status}] "${workflow.name}" phase ${workflow.currentPhase === undefined ? "-" : workflow.currentPhase + 1}/${workflow.phases.length}`).join("\n")
						: "No OpenCode workflows.",
				}],
				details: { workflows: all.map((workflow) => ({ id: workflow.id, status: workflow.status })) },
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
					`Binary: ${config.binary}`,
					`Timeout: ${config.timeoutMs} ms`,
					`Running: ${tasks.runningCount()}/${config.maxRunning}`,
					`Workflows: ${workflows.list().filter((item) => item.status === "running").length} running`,
				].join("\n"),
				"info",
			);
		},
	});

	registerModelCommand(pi, tasks);
}
