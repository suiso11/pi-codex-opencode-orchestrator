/**
 * Repository-specific outbound context pruning for OpenCode orchestration results.
 *
 * Pi fires the `context` event with a deep copy of the session messages just
 * before each model call. This module non-destructively replaces the
 * model-facing content of OLD orchestration results so the parent model does not
 * keep re-reading large worker summaries, while leaving the session JSONL and the
 * manager's retained raw output untouched.
 *
 * The pruning is deliberately one-turn: a freshly returned tool result or
 * background batch remains available for the immediate next model call and is
 * pruned starting with the following user turn.
 */

export interface OrchestrationResultLike {
	role: string;
	content?: unknown;
	toolName?: string;
	toolCallId?: string;
	customType?: string;
	display?: boolean;
	details?: unknown;
	timestamp?: number;
}

export interface PruneOrchestrationStats {
	prunedMessages: number;
	charsRemoved: number;
}

export interface PruneOrchestrationResult<T> extends PruneOrchestrationStats {
	messages: T[];
}

const MAX_PRESERVED_IDS = 8;

function isToolResultTarget(message: OrchestrationResultLike): boolean {
	return (
		message.role === "toolResult" &&
		typeof message.toolName === "string" &&
		message.toolName.startsWith("opencode_")
	);
}

function isCustomBatchTarget(message: OrchestrationResultLike): boolean {
	return (
		message.role === "custom" &&
		message.customType === "opencode-batch-result"
	);
}

function isTarget(message: OrchestrationResultLike): boolean {
	return isToolResultTarget(message) || isCustomBatchTarget(message);
}

function textContentLength(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const part of content) {
		if (part && typeof part === "object") {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") total += text.length;
		}
	}
	return total;
}

function collectPreservedIds(details: unknown, out: string[]): void {
	if (!details || typeof details !== "object") return;
	const record = details as Record<string, unknown>;
	if (typeof record.id === "string" && record.id) out.push(record.id);
	for (const key of ["tasks", "workflows", "results"]) {
		const value = record[key];
		if (!Array.isArray(value)) continue;
		for (const item of value) {
			if (item && typeof item === "object") {
				const id = (item as Record<string, unknown>).id;
				if (typeof id === "string" && id) out.push(id);
			}
		}
	}
}

function placeholderFor(message: OrchestrationResultLike): string {
	const ids: string[] = [];
	collectPreservedIds(message.details, ids);
	const unique = [...new Set(ids)].slice(0, MAX_PRESERVED_IDS);
	let text = "[OpenCode orchestration result pruned to preserve context.";
	if (unique.length > 0) text += ` IDs: ${unique.join(", ")}`;
	text += "]";
	return text;
}

/**
 * Return a new messages array with OLD OpenCode orchestration results replaced
 * by a short placeholder. A target is pruned only when it appears before the
 * latest real user-role message, so the current turn's freshly returned result
 * stays available for the immediate next model call.
 */
export function pruneOrchestrationResults<T extends OrchestrationResultLike>(
	messages: T[],
): PruneOrchestrationResult<T> {
	let lastUserIndex = -1;
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === "user") lastUserIndex = i;
	}

	const next: T[] = [];
	let prunedMessages = 0;
	let charsRemoved = 0;

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (i < lastUserIndex && isTarget(message)) {
			const placeholder = placeholderFor(message);
			charsRemoved += Math.max(0, textContentLength(message.content) - placeholder.length);
			if (message.role === "toolResult") {
				next.push({ ...message, content: [{ type: "text", text: placeholder }] } as T);
			} else {
				next.push({ ...message, content: placeholder } as T);
			}
			prunedMessages++;
		} else {
			next.push(message);
		}
	}

	return { messages: next, prunedMessages, charsRemoved };
}
