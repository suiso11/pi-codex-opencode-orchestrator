import type { TaskSpec, TaskSnapshot, WorkflowPhaseSpec } from "./types.ts";

export interface VerifiedTaskInput {
	name: string;
	objective: string;
	relevantPaths: string[];
	constraints?: string[];
	expectedOutput: string;
	worktree?: boolean;
	implementerModel?: string;
	testerModel?: string;
	reviewerModel?: string;
}

/**
 * Marker for the internal quality gate carried by the tester and reviewer
 * phases of the verified workflow. A gated phase that settles with every task
 * status=done still fails the workflow when any task report lists a non-empty
 * unresolved array: the next phase never starts and no approval is granted.
 */
export const REQUIRE_RESOLVED_GATE = "requireResolved";

export const REQUIRE_RESOLVED_CONSTRAINT =
	'Internal quality gate "requireResolved": report every failure or blocker in report.unresolved. A non-empty report.unresolved fails this workflow phase and blocks the next phase; there is no automatic retry.';

export interface ResolvedGateViolation {
	taskId: string;
	taskName: string;
	unresolved: string[];
}

/** Collect gate violations: done-status workers whose report.unresolved is non-empty. */
export function collectUnresolvedIssues(results: TaskSnapshot[]): ResolvedGateViolation[] {
	const violations: ResolvedGateViolation[] = [];
	for (const task of results) {
		const unresolved = task.report?.unresolved ?? [];
		if (unresolved.length > 0) {
			violations.push({ taskId: task.id, taskName: task.name, unresolved });
		}
	}
	return violations;
}

/**
 * Build the standard three-phase verification loop:
 * implementer (write) -> tester (read_only, gated) -> reviewer (read_only, gated).
 * The tester and reviewer phases carry requireResolved; a test failure surfaces
 * as a worker status error and stops the workflow through the existing failure
 * path. Final approval always stays with the parent, never with a worker.
 */
export function buildVerifiedPhases(input: VerifiedTaskInput): WorkflowPhaseSpec[] {
	const constraints = input.constraints ?? [];
	const implementer: TaskSpec = {
		name: `${input.name}: implement`,
		mode: "write",
		role: "implementer",
		objective: input.objective,
		relevantPaths: input.relevantPaths,
		constraints: [...constraints],
		expectedOutput: input.expectedOutput,
		model: input.implementerModel,
		worktree: input.worktree,
	};
	const tester: TaskSpec = {
		name: `${input.name}: test`,
		mode: "read_only",
		role: "tester",
		objective: `Run the standard verification loop for "${input.name}": execute the relevant tests/verification commands and report failures. Objective: ${input.objective}`,
		relevantPaths: input.relevantPaths,
		constraints: [...constraints, REQUIRE_RESOLVED_CONSTRAINT],
		expectedOutput: `Verification evidence for: ${input.expectedOutput}`,
		model: input.testerModel,
	};
	const reviewer: TaskSpec = {
		name: `${input.name}: review`,
		mode: "read_only",
		role: "reviewer",
		objective: `Independently review the implemented change for "${input.name}" against the objective and report any remaining issues. Objective: ${input.objective}`,
		relevantPaths: input.relevantPaths,
		constraints: [...constraints, REQUIRE_RESOLVED_CONSTRAINT],
		expectedOutput: `Review verdict with concrete findings for: ${input.expectedOutput}`,
		model: input.reviewerModel,
	};
	return [
		{ name: "implement", tasks: [implementer] },
		{ name: "test", tasks: [tester], requireResolved: true },
		{ name: "review", tasks: [reviewer], requireResolved: true },
	];
}
