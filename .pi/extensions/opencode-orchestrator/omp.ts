import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";

// Keep the orchestration policy in index.ts; translate only OMP's API dialect.
export function adaptOmp(api: ExtensionAPI): ExtensionAPI {
	let pendingTools = Promise.resolve();
	const adaptContext = (ctx: any) => ctx && new Proxy(ctx, {
		get(target, key) {
			if (key === "scopedModels") return target.scopedModels ?? [];
			// Mark OMP so the portable picker uses its fullscreen mouse-enabled overlay.
			if (key === "mode" && target.mode === "tui") return "omp";
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const wrap = (handler: (...args: any[]) => any, eventName?: string) => async (event: any, ctx: any) => {
		if (ctx?.agent && (ctx.agent.depth > 0 || ctx.agent.parentId)) return;
		let translated = event;
		if (eventName === "before_agent_start") {
			translated = { ...event, systemPrompt: Array.isArray(event.systemPrompt) ? event.systemPrompt.join("\n\n") : event.systemPrompt };
		} else if (eventName === "tool_call") {
			const aliases: Record<string, string> = {glob: "find", task: "opencode_spawn", wait: "opencode_wait"};
			if (aliases[event.toolName]) translated = { ...event, toolName: aliases[event.toolName] };
			// Native agent control and bounded handoff files use OMP's URI protocols.
			if (event.toolName === "write" && /^(agent|proc|local):\/\//.test(event.input?.path ?? "")) {
				translated = { ...event, toolName: "opencode_spawn" };
			}
		}
		const result = await handler(translated, adaptContext(ctx));
		await pendingTools;
		if (eventName === "before_agent_start" && result?.systemPrompt) {
			return { ...result, systemPrompt: [result.systemPrompt
				.replace("read, grep, find, ls", "read, grep, glob")
				.replace("through opencode_* tools", "through OMP task or opencode_* tools")
				+ "\n- Prefer OMP task for native parallel workers. Use isolated: true for write workers that run in parallel; OMP owns workspace isolation and integration. Use wait to collect native workers and opencode_wait for OpenCode workers. Native coordination through write agent://, proc://, or local:// is allowed; writing repository files directly is not.\n- The parent's coordinator restrictions do not apply to native child workers."] };
		}
		return result;
	};
	return new Proxy(api, {
		get(target, key) {
			if (key === "on") return (name: string, handler: (...args: any[]) => any) => {
				const actual = name === "agent_settled" ? "agent_end" : name;
				(target.on as any)(actual, wrap(handler, name));
			};
			if (key === "getActiveTools") return () => target.getActiveTools().map(name => name === "glob" ? "find" : name);
			if (key === "setActiveTools") return (names: string[]) => {
				const mapped = [...new Set(["task", "wait", ...names.filter(name => name !== "ls").map(name => name === "find" ? "glob" : name)])];
				pendingTools = pendingTools.then(() => (target.setActiveTools as any)(mapped));
				return pendingTools;
			};
			if (key === "registerTool") return (tool: any) => target.registerTool({
				...tool,
				async execute(id: string, params: any, signal: any, update: any, ctx: any) {
					const result = await tool.execute(id, params, signal, update, adaptContext(ctx));
					await pendingTools;
					return result;
				},
			});
			if (key === "registerCommand") return (name: string, command: any) => target.registerCommand(name, {
				...command, handler: wrap(command.handler),
			});
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export default function ompExtension(api: ExtensionAPI) {
	extension(adaptOmp(api));
}
