import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	InternalTaskSpec,
	ModelProfile,
	TaskMode,
	TaskSnapshot,
	TaskSpec,
	ThinkingLevel,
} from "./types.ts";
import {
	boundedAppend,
	buildAgentFrontmatter,
	buildWorkerPrompt,
	configuredModelCapabilities,
	configuredModelProfiles,
	configuredThinkingLevel,
	decodeWorkerModel,
	DEFAULT_MODEL,
	DEFAULT_TOOL_PROFILE,
	enforceToolLimit,
	extractUsageFromEvent,
	findScopeConflict,
	MAX_ACTIVITY_ITEMS,
	MAX_RUNNING,
	MAX_TRACKED,
	mergeUsage,
	normalizeScopes,
	parseWorkerReport,
	resolveModel,
	resolveThinkingLevel,
	resolveToolProfile,
	toolsForProfile,
	type ModelCapability,
	type ToolProfile,
} from "./types.ts";

function opencodeAgentDir(): string {
	// OpenCode resolves agents by name from ~/.config/opencode/agent/ on every platform.
	return path.join(os.homedir(), ".config", "opencode", "agent");
}

function writeAgentDefinition(taskId: string, profile: ToolProfile, mode: TaskMode): string {
	const frontmatter = buildAgentFrontmatter(profile, mode);
	const body = "You are a bounded worker delegated by a parent Pi orchestrator. Follow the repository's AGENTS.md. Do not read secrets or git-ignored runtime configuration. Stay within the declared scope and report missing scope instead of broadening the task.";
	const dir = opencodeAgentDir();
	mkdirSync(dir, { recursive: true });
	const name = `pi-orch-${taskId}-${randomBytes(4).toString("hex")}`;
	const file = path.join(dir, `${name}.md`);
	writeFileSync(file, `${frontmatter}
${body}
`, { encoding: "utf-8" });
	return name;
}

function cleanupAgentDefinition(name: string | undefined) {
	if (!name) return;
	const file = path.join(opencodeAgentDir(), `${name}.md`);
	try { unlinkSync(file); } catch { /* already removed or missing */ }
}

interface ManagedTask {
	snapshot: TaskSnapshot;
	child?: ChildProcess;
	buffer: string;
	settleListeners: Set<() => void>;
	waiters: number;
	consumed: boolean;
	delivered: boolean;
	cancelRequested: boolean;
}

interface ManagerOptions {
	onChange?: () => void;
	binary?: string;
	binaryArgs?: string[];
	model?: string;
	timeoutMs?: number;
	piBinary?: string;
	piBinaryArgs?: string[];
	thinkingLevel?: ThinkingLevel;
	modelCapabilities?: Record<string, ModelCapability>;
	defaultToolProfile?: ToolProfile;
}

function defaultPiCommand() {
	try {
		const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		return {
			binary: process.execPath,
			args: [path.join(path.dirname(packageEntry), "cli.js")],
		};
	} catch {
		return {
			binary: "pi",
			args: [],
		};
	}
}

function configuredTimeout(value?: number) {
	const parsed = value ?? Number(process.env.PI_OPENCODE_TIMEOUT_MS ?? 10 * 60 * 1000);
	if (!Number.isFinite(parsed)) return 10 * 60 * 1000;
	return Math.min(Math.max(parsed, 10_000), 30 * 60 * 1000);
}

function processError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
	if (!child.pid) return;
	try {
		if (os.platform() !== "win32") process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// The process may already have exited.
		}
	}
}

function activityFromEvent(event: Record<string, unknown>) {
	const part = event.part && typeof event.part === "object"
		? event.part as Record<string, unknown>
		: undefined;
	const type = typeof event.type === "string" ? event.type : "event";
	if (!part) return type;
	if (part.type === "tool") {
		const tool = typeof part.tool === "string" ? part.tool : "tool";
		const state = part.state && typeof part.state === "object"
			? part.state as Record<string, unknown>
			: undefined;
		const status = state && typeof state.status === "string" ? state.status : "update";
		return `${tool}: ${status}`;
	}
	if (part.type === "step-finish") {
		return `step finished: ${typeof part.reason === "string" ? part.reason : "unknown"}`;
	}
	return `${type}: ${String(part.type ?? "unknown")}`;
}

export class OpenCodeTaskManager {
	private readonly tasks = new Map<string, ManagedTask>();
	private counter = 0;
	private disposed = false;
	private capacityListeners = new Set<() => void>();
	private readonly onChange?: () => void;
	private readonly binary: string;
	private readonly binaryArgs: string[];
	private defaultModel: string;
	private modelProfiles: Record<ModelProfile, string>;
	private readonly timeoutMs: number;
	private readonly piBinary: string;
	private readonly piBinaryArgs: string[];
	private thinkingLevel: ThinkingLevel;
	private readonly modelCapabilities: Record<string, ModelCapability>;
	private readonly defaultToolProfile: ToolProfile;

	constructor(options: ManagerOptions = {}) {
		this.onChange = options.onChange;
		this.binary = options.binary ?? process.env.PI_OPENCODE_BIN ?? "opencode";
		this.binaryArgs = options.binaryArgs ?? [];
		this.defaultModel = options.model ?? process.env.PI_OPENCODE_MODEL ?? DEFAULT_MODEL;
		this.modelProfiles = configuredModelProfiles();
		this.timeoutMs = configuredTimeout(options.timeoutMs);
		this.thinkingLevel = options.thinkingLevel ?? configuredThinkingLevel();
		this.modelCapabilities = options.modelCapabilities ?? configuredModelCapabilities();
		this.defaultToolProfile = options.defaultToolProfile ?? DEFAULT_TOOL_PROFILE;
		const piCommand = defaultPiCommand();
		this.piBinary = options.piBinary ?? piCommand.binary;
		this.piBinaryArgs = options.piBinaryArgs ?? piCommand.args;
	}

	configuration() {
		return {
			binary: this.binary,
			piBinary: this.piBinary,
			model: this.defaultModel,
			profiles: { ...this.modelProfiles },
			timeoutMs: this.timeoutMs,
			maxRunning: MAX_RUNNING,
			thinkingLevel: this.thinkingLevel,
		};
	}

	setModelSetting(target: "worker" | ModelProfile, model: string) {
		const value = model.trim();
		if (!value) throw new Error("OpenCode model must not be empty.");
		if (target === "worker") this.defaultModel = value;
		else this.modelProfiles[target] = value;
		this.notify();
	}

	setThinkingLevel(level: ThinkingLevel) {
		this.thinkingLevel = level;
		this.notify();
	}

	private notify() {
		this.onChange?.();
		for (const listener of this.capacityListeners) listener();
		this.capacityListeners.clear();
	}

	private runningEntries() {
		return [...this.tasks.values()].filter((entry) => entry.snapshot.status === "running");
	}

	runningCount() {
		return this.runningEntries().length;
	}

	private conflictFor(spec: InternalTaskSpec, cwd: string) {
		if (spec.mode !== "write") return undefined;
		const scopes = normalizeScopes(cwd, spec.relevantPaths);
		for (const entry of this.runningEntries()) {
			if (entry.snapshot.mode !== "write") continue;
			const conflict = findScopeConflict(scopes, entry.snapshot.scopes);
			if (conflict) return { task: entry.snapshot, conflict };
		}
		return undefined;
	}

	private spawnBlockReason(spec: InternalTaskSpec, cwd: string) {
		if (this.disposed) return "OpenCode task manager is shut down.";
		if (this.runningCount() >= MAX_RUNNING) return `OpenCode concurrency limit reached (${MAX_RUNNING}).`;
		const conflict = this.conflictFor(spec, cwd);
		if (conflict) {
			return `Write scope conflicts with running task ${conflict.task.id} "${conflict.task.name}": ${conflict.conflict.left} overlaps ${conflict.conflict.right}`;
		}
		return undefined;
	}

	spawn(spec: InternalTaskSpec, cwd: string) {
		const blockReason = this.spawnBlockReason(spec, cwd);
		if (blockReason) throw new Error(blockReason);
		const scopes = normalizeScopes(cwd, spec.relevantPaths);
		const id = `oc-${++this.counter}`;
		const selection = decodeWorkerModel(resolveModel(spec, this.defaultModel, this.modelProfiles));
		const snapshot: TaskSnapshot = {
			id,
			name: spec.name.trim().slice(0, 160) || id,
			mode: spec.mode,
			status: "running",
			objective: spec.objective,
			relevantPaths: [...spec.relevantPaths],
			scopes,
			model: selection.model,
			backend: selection.backend,
			workflowId: spec.workflowId,
			createdAt: Date.now(),
			output: "",
			stderr: "",
			activity: [],
			timedOut: false,
			truncated: false,
		};
		const entry: ManagedTask = {
			snapshot,
			buffer: "",
			settleListeners: new Set(),
			waiters: 0,
			consumed: false,
			delivered: false,
			cancelRequested: false,
		};
		this.tasks.set(id, entry);
		this.prune();
		this.start(entry, spec, cwd);
		this.notify();
		return snapshot;
	}

	async spawnWhenAvailable(spec: InternalTaskSpec, cwd: string, signal?: AbortSignal) {
		while (true) {
			if (signal?.aborted) throw new Error("Operation was aborted.");
			const reason = this.spawnBlockReason(spec, cwd);
			if (!reason) {
				if (signal?.aborted) throw new Error("Operation was aborted.");
				return this.spawn(spec, cwd);
			}
			if (reason.includes("shut down")) throw new Error(reason);
			await this.waitForChange(signal);
		}
	}

	private waitForChange(signal?: AbortSignal) {
		if (signal?.aborted) return Promise.reject(new Error("Operation was aborted."));
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => listener(), 250);
			timer.unref();
			const listener = () => {
				cleanup();
				resolve();
			};
			const onAbort = () => {
				cleanup();
				reject(new Error("Operation was aborted."));
			};
			const cleanup = () => {
				clearTimeout(timer);
				this.capacityListeners.delete(listener);
				signal?.removeEventListener("abort", onAbort);
			};
			this.capacityListeners.add(listener);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private start(entry: ManagedTask, spec: TaskSpec, cwd: string) {
		const prompt = buildWorkerPrompt(spec);
		const isPiWorker = entry.snapshot.backend === "pi";
		const thinking = resolveThinkingLevel(spec, this.thinkingLevel);
		const binary = isPiWorker ? this.piBinary : this.binary;
		// Tool capability routing: OpenCode workers get a generated agent definition so
		// the parent owns the tool set, instead of inheriting ambient OpenCode config.
		// Pi workers already pass --tools explicitly.
		let agentName: string | undefined;
		let capabilityNotice: string | undefined;
		if (!isPiWorker) {
			const profile = resolveToolProfile(spec, this.defaultToolProfile);
			const capability = this.modelCapabilities[entry.snapshot.model];
			const tools = enforceToolLimit(toolsForProfile(profile, spec.mode), capability);
			if (tools.reduced) capabilityNotice = tools.reason;
			agentName = writeAgentDefinition(entry.snapshot.id, profile, spec.mode);
			entry.snapshot.activity.push(`agent profile: ${profile} (${tools.tools.join(",")})`);
			if (capabilityNotice) entry.snapshot.activity.push(`capability: ${capabilityNotice}`);
			if (entry.snapshot.activity.length > MAX_ACTIVITY_ITEMS) entry.snapshot.activity.shift();
		}
		const args = isPiWorker
			? [
				...this.piBinaryArgs,
				"--approve",
				"--no-session",
				"--no-extensions",
				"--mode",
				"json",
				"--model",
				entry.snapshot.model,
				"--thinking",
				thinking,
				"--tools",
				spec.mode === "read_only" ? "read,grep,find,ls" : "read,grep,find,ls,bash,edit,write",
				prompt,
			]
			: [
				...this.binaryArgs,
				"run",
				"--format",
				"json",
				"--model",
				entry.snapshot.model,
				"--variant",
				thinking,
				...(agentName ? ["--agent", agentName] : []),
				prompt,
			];
		const child = spawn(binary, args, {
			cwd,
			env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
			detached: os.platform() !== "win32",
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		entry.child = child;

		const timeout = setTimeout(() => {
			entry.snapshot.timedOut = true;
			entry.snapshot.error = `${isPiWorker ? "Pi" : "OpenCode"} worker timed out after ${this.timeoutMs} ms.`;
			killProcessTree(child, "SIGTERM");
			setTimeout(() => { killProcessTree(child, "SIGKILL"); cleanupAgentDefinition(agentName); }, 5_000).unref();
		}, this.timeoutMs);
		timeout.unref();

		child.stdout?.on("data", (data: Buffer) => this.consumeStdout(entry, data.toString("utf8")));
		child.stderr?.on("data", (data: Buffer) => {
			const appended = boundedAppend(entry.snapshot.stderr, data.toString("utf8"));
			entry.snapshot.stderr = appended.text;
			entry.snapshot.truncated ||= appended.truncated;
			this.notify();
		});
		child.on("error", (error) => {
			entry.snapshot.error = `Failed to start ${isPiWorker ? "Pi" : "OpenCode"} worker: ${processError(error)}`;
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			cleanupAgentDefinition(agentName);
			if (entry.buffer.trim()) this.consumeLine(entry, entry.buffer);
			entry.buffer = "";
			entry.snapshot.exitCode = code ?? 1;
			entry.snapshot.settledAt = Date.now();
			entry.snapshot.report = parseWorkerReport(entry.snapshot.output);
			if (entry.cancelRequested) entry.snapshot.status = "cancelled";
			else if (entry.snapshot.timedOut || code !== 0 || entry.snapshot.error) {
				entry.snapshot.status = "error";
				entry.snapshot.error ??= `${isPiWorker ? "Pi" : "OpenCode"} worker exited with code ${code ?? 1}.`;
			} else entry.snapshot.status = "done";
			entry.child = undefined;
			for (const listener of entry.settleListeners) listener();
			entry.settleListeners.clear();
			this.notify();
		});
	}

	private consumeStdout(entry: ManagedTask, chunk: string) {
		entry.buffer += chunk;
		const lines = entry.buffer.split("\n");
		entry.buffer = lines.pop() ?? "";
		for (const line of lines) this.consumeLine(entry, line);
		this.notify();
	}

	private consumeLine(entry: ManagedTask, line: string) {
		if (!line.trim()) return;
		let event: Record<string, unknown> | undefined;
		try {
			const parsed: unknown = JSON.parse(line);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) event = parsed as Record<string, unknown>;
		} catch {
			// OpenCode may emit a plain diagnostic line before JSON events.
		}
		if (!event) {
			const appended = boundedAppend(entry.snapshot.output, `${line}\n`);
			entry.snapshot.output = appended.text;
			entry.snapshot.truncated ||= appended.truncated;
			if (entry.snapshot.backend === "pi") {
				entry.snapshot.activity.push("Pi response streaming");
				if (entry.snapshot.activity.length > MAX_ACTIVITY_ITEMS) entry.snapshot.activity.shift();
			}
			return;
		}
		const part = event.part && typeof event.part === "object"
			? event.part as Record<string, unknown>
			: undefined;
		// OpenCode text streaming remains the primary output path for OpenCode workers.
		if (event.type === "text" && part && typeof part.text === "string") {
			const appended = boundedAppend(entry.snapshot.output, `${part.text}\n`);
			entry.snapshot.output = appended.text;
			entry.snapshot.truncated ||= appended.truncated;
		}
		// Pi JSON mode: append assistant text content at message_end (not message_update,
		// to avoid double-counting streaming deltas). Usage is captured separately below.
		if (event.type === "message_end") {
			const message = event.message && typeof event.message === "object"
				? event.message as Record<string, unknown>
				: undefined;
			const content = message?.content;
			if (Array.isArray(content)) {
				for (const item of content) {
					if (item && typeof item === "object") {
						const node = item as Record<string, unknown>;
						if (node.type === "text" && typeof node.text === "string") {
							const appended = boundedAppend(entry.snapshot.output, `${node.text}\n`);
							entry.snapshot.output = appended.text;
							entry.snapshot.truncated ||= appended.truncated;
						}
					}
				}
			}
		}
		const usage = extractUsageFromEvent(event);
		if (usage) {
			entry.snapshot.usage = mergeUsage(entry.snapshot.usage, usage);
		}
		entry.snapshot.activity.push(activityFromEvent(event));
		if (entry.snapshot.activity.length > MAX_ACTIVITY_ITEMS) entry.snapshot.activity.shift();
	}

	get(id: string) {
		return this.tasks.get(id)?.snapshot;
	}

	list() {
		return [...this.tasks.values()].map((entry) => entry.snapshot);
	}

	private waitOne(entry: ManagedTask, signal?: AbortSignal) {
		if (entry.snapshot.status !== "running") return Promise.resolve();
		if (signal?.aborted) return Promise.reject(new Error("Wait was aborted; workers keep running."));
		return new Promise<void>((resolve, reject) => {
			const listener = () => {
				cleanup();
				resolve();
			};
			const onAbort = () => {
				cleanup();
				reject(new Error("Wait was aborted; workers keep running."));
			};
			const cleanup = () => {
				entry.settleListeners.delete(listener);
				signal?.removeEventListener("abort", onAbort);
			};
			entry.settleListeners.add(listener);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	async wait(ids: string[], signal?: AbortSignal, consume = true) {
		const entries = [...new Set(ids)].map((id) => {
			const entry = this.tasks.get(id);
			if (!entry) throw new Error(`Unknown OpenCode task id: ${id}`);
			return entry;
		});
		for (const entry of entries) entry.waiters++;
		try {
			await Promise.all(entries.map((entry) => this.waitOne(entry, signal)));
			if (consume) for (const entry of entries) entry.consumed = true;
			return entries.map((entry) => entry.snapshot);
		} finally {
			for (const entry of entries) entry.waiters = Math.max(0, entry.waiters - 1);
		}
	}

	async cancel(ids: string[]) {
		const unique = [...new Set(ids)];
		for (const id of unique) {
			const entry = this.tasks.get(id);
			if (!entry) throw new Error(`Unknown OpenCode task id: ${id}`);
			entry.consumed = true;
			if (entry.snapshot.status !== "running" || !entry.child) continue;
			entry.cancelRequested = true;
			killProcessTree(entry.child, "SIGTERM");
			setTimeout(() => entry.child && killProcessTree(entry.child, "SIGKILL"), 5_000).unref();
		}
		return this.wait(unique, undefined, true);
	}

	drainDeliverable() {
		const ready: TaskSnapshot[] = [];
		for (const entry of this.tasks.values()) {
			if (
				entry.snapshot.status !== "running" &&
				!entry.snapshot.workflowId &&
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

	private prune() {
		if (this.tasks.size < MAX_TRACKED) return;
		const settled = [...this.tasks.values()]
			.filter((entry) => entry.snapshot.status !== "running")
			.sort((a, b) => (a.snapshot.settledAt ?? 0) - (b.snapshot.settledAt ?? 0));
		while (this.tasks.size >= MAX_TRACKED && settled.length > 0) {
			const entry = settled.shift();
			if (entry) this.tasks.delete(entry.snapshot.id);
		}
	}

	async dispose() {
		this.disposed = true;
		const running = this.runningEntries();
		for (const entry of running) {
			entry.cancelRequested = true;
			if (entry.child) {
				const child = entry.child;
				killProcessTree(child, "SIGTERM");
				setTimeout(() => killProcessTree(child, "SIGKILL"), 5_000).unref();
			}
		}
		await Promise.all(running.map((entry) => this.waitOne(entry).catch(() => undefined)));
	}
}
