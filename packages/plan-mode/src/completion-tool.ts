export const PLAN_MODE_COMPLETE_TOOL_NAME = "plan_mode_complete";
export const PLAN_MODE_COMPLETE_VERSION = 1;
export const PLAN_MODE_MAX_CHARS = 50_000;

export type PlanSpec = {
	title: string;
	goal: string;
	requirements: Array<{
		requirement: string;
		implementation: string[];
		acceptanceChecks: string[];
	}>;
	assumptions?: string[];
};

export type PlanModeCompletionDetails = {
	version: typeof PLAN_MODE_COMPLETE_VERSION;
	source: typeof PLAN_MODE_COMPLETE_TOOL_NAME;
	plan: string;
};

const NON_EMPTY_STRING = { type: "string", minLength: 1 } as const;

export const PLAN_MODE_COMPLETE_PARAMS = {
	type: "object",
	additionalProperties: false,
	required: ["title", "goal", "requirements"],
	properties: {
		title: {
			...NON_EMPTY_STRING,
			description: "A concise title for the complete plan.",
		},
		goal: {
			...NON_EMPTY_STRING,
			description: "The overall outcome the implementation must achieve.",
		},
		requirements: {
			type: "array",
			minItems: 1,
			description: "Complete requirements, each paired with its implementation approach and acceptance checks.",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["requirement", "implementation", "acceptanceChecks"],
				properties: {
					requirement: {
						...NON_EMPTY_STRING,
						description: "One concrete requirement or constraint.",
					},
					implementation: {
						type: "array",
						minItems: 1,
						items: NON_EMPTY_STRING,
						description: "Behavior-level changes that will satisfy this requirement.",
					},
					acceptanceChecks: {
						type: "array",
						minItems: 1,
						items: NON_EMPTY_STRING,
						description: "Tests or observable checks that will verify this requirement after implementation.",
					},
				},
			},
		},
		assumptions: {
			type: "array",
			items: NON_EMPTY_STRING,
			description: "Optional low-risk defaults or assumptions that the user should see.",
		},
	},
} as const;

type NormalizePlanModeCompletionResult = { ok: true; plan: string } | { ok: false; error: string };
type NormalizePlanMarkdownResult = { ok: true; plan: string } | { ok: false; error: string };

export function normalizePlanModeCompletion(input: unknown): NormalizePlanModeCompletionResult {
	if (!isRecord(input)) return { ok: false, error: "plan must be an object" };

	const title = normalizedText(input.title);
	if (!title) return { ok: false, error: "title must be a non-empty string" };
	const goal = normalizedText(input.goal);
	if (!goal) return { ok: false, error: "goal must be a non-empty string" };
	if (!Array.isArray(input.requirements) || input.requirements.length === 0) {
		return { ok: false, error: "requirements must contain at least one item" };
	}

	const requirements: PlanSpec["requirements"] = [];
	const seenRequirements = new Set<string>();
	for (const [index, candidate] of input.requirements.entries()) {
		const path = `requirements[${index}]`;
		if (!isRecord(candidate)) return { ok: false, error: `${path} must be an object` };

		const requirement = normalizedText(candidate.requirement);
		if (!requirement) return { ok: false, error: `${path}.requirement must be a non-empty string` };
		const duplicateKey = requirement.toLocaleLowerCase();
		if (seenRequirements.has(duplicateKey)) {
			return { ok: false, error: `${path}.requirement duplicates an earlier requirement` };
		}
		seenRequirements.add(duplicateKey);

		const implementation = normalizedTextArray(candidate.implementation, `${path}.implementation`);
		if (!implementation.ok) return implementation;
		const acceptanceChecks = normalizedTextArray(candidate.acceptanceChecks, `${path}.acceptanceChecks`);
		if (!acceptanceChecks.ok) return acceptanceChecks;

		requirements.push({
			requirement,
			implementation: implementation.values,
			acceptanceChecks: acceptanceChecks.values,
		});
	}

	let assumptions: string[] | undefined;
	if (input.assumptions !== undefined) {
		const normalized = normalizedTextArray(input.assumptions, "assumptions", true);
		if (!normalized.ok) return normalized;
		assumptions = normalized.values.length > 0 ? normalized.values : undefined;
	}

	const plan = renderPlanSpec({ title, goal, requirements, assumptions });
	return normalizePlanMarkdown(plan);
}

export function normalizePlanMarkdown(value: unknown): NormalizePlanMarkdownResult {
	if (typeof value !== "string") return { ok: false, error: "plan must be a string" };
	const plan = value.trim();
	if (!plan) return { ok: false, error: "plan must not be empty" };
	if (plan.length > PLAN_MODE_MAX_CHARS) {
		return { ok: false, error: `plan must not exceed ${PLAN_MODE_MAX_CHARS} characters` };
	}
	return { ok: true, plan };
}

export function planFromCompletionDetails(value: unknown) {
	if (!isRecord(value)) return undefined;
	if (value.version !== PLAN_MODE_COMPLETE_VERSION || value.source !== PLAN_MODE_COMPLETE_TOOL_NAME) {
		return undefined;
	}
	const normalized = normalizePlanMarkdown(value.plan);
	return normalized.ok ? normalized.plan : undefined;
}

export function planModeCompleted(plan: string) {
	return {
		content: [{ type: "text" as const, text: `**Proposed Plan**\n\n${plan}` }],
		details: {
			version: PLAN_MODE_COMPLETE_VERSION,
			source: PLAN_MODE_COMPLETE_TOOL_NAME,
			plan,
		} satisfies PlanModeCompletionDetails,
		terminate: true,
	};
}

function renderPlanSpec(spec: PlanSpec): string {
	const sections = [
		`# ${spec.title}`,
		`## Goal\n\n${spec.goal}`,
		`## Requirements and Implementation\n\n${spec.requirements
			.map(
				(item, index) =>
					`### ${index + 1}. ${item.requirement}\n\n**Implementation**\n\n${markdownList(item.implementation)}\n\n**Acceptance checks**\n\n${markdownList(item.acceptanceChecks)}`,
			)
			.join("\n\n")}`,
	];
	if (spec.assumptions?.length) sections.push(`## Assumptions\n\n${markdownList(spec.assumptions)}`);
	return sections.join("\n\n");
}

function markdownList(items: string[]) {
	return items.map((item) => `- ${item}`).join("\n");
}

function normalizedTextArray(
	value: unknown,
	path: string,
	allowEmpty = false,
): { ok: true; values: string[] } | { ok: false; error: string } {
	if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
		return { ok: false, error: `${path} must contain at least one item` };
	}
	const values: string[] = [];
	for (const [index, candidate] of value.entries()) {
		const text = normalizedText(candidate);
		if (!text) return { ok: false, error: `${path}[${index}] must be a non-empty string` };
		values.push(text);
	}
	return { ok: true, values };
}

function normalizedText(value: unknown) {
	return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
