import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	normalizePlanModeCompletion,
	PLAN_MODE_COMPLETE_PARAMS,
	PLAN_MODE_COMPLETE_TOOL_NAME,
	planModeCompleted,
} from "./completion-tool.ts";
import {
	isEmptyAssistantMessage,
	latestAssistantText,
	messageContainsInactivePlanModeArtifact,
	messageContainsLegacyPlanModeContextArtifact,
	messageContainsPlanModeImplementationHandoff,
	parseProposedPlan,
	stripPlanModeCompletionCallsFromMessage,
	stripProposedPlanBlocksFromMessage,
} from "./message-transform.ts";
import { buildPlanModePrompt } from "./prompt.ts";
import {
	askPlanModeQuestions,
	normalizePlanModeQuestionParams,
	PLAN_MODE_QUESTION_PARAMS,
	PLAN_MODE_QUESTION_TOOL_NAME,
	planModeQuestionAnswered,
	planModeQuestionCancelled,
} from "./question-tool.ts";
import {
	configuredThinkingLevel,
	type PlanModeFixedThinkingLevel,
	type PlanModeSettings,
	readPlanModeSettings,
} from "./settings.ts";
import { type PlanCompletionSource, type PlanModeState, restorePlanModeState } from "./state.ts";

const STATE_ENTRY_TYPE = "plan-mode-state";
const STATUS_KEY = "plan-mode";
const PLAN_WIDGET_KEY = "plan-mode-plan";
const PROPOSED_PLAN_MESSAGE_TYPE = "proposed-plan";
const IMPLEMENT_PLAN_CHOICE = "执行计划";
const CONTINUE_PLANNING_CHOICE = "继续规划";
const DISCARD_PLAN_CHOICE = "放弃计划";
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const FIXED_PLAN_TOOLS = ["read", "bash", "grep", "find", "ls", "memory_read"] as const;
const ALLOWED_PLAN_TOOLS = new Set<string>([
	...FIXED_PLAN_TOOLS,
	PLAN_MODE_QUESTION_TOOL_NAME,
	PLAN_MODE_COMPLETE_TOOL_NAME,
]);
const SUBAGENT_MANAGER_KEY = Symbol.for("pi-subagents:manager");

interface SubagentPlanGate {
	tryEnterPlanMode(): "entered" | "busy";
	exitPlanMode(): void;
}

type AgentSettledHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function onAgentSettled(pi: ExtensionAPI, handler: AgentSettledHandler) {
	(
		pi as unknown as {
			on(event: "agent_settled", callback: AgentSettledHandler): void;
		}
	).on("agent_settled", handler);
}

function setPlanThinkingLevel(pi: ExtensionAPI, level: PlanModeFixedThinkingLevel) {
	(pi.setThinkingLevel as unknown as (level: PlanModeFixedThinkingLevel) => void)(level);
}

interface CommandArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

interface ReadyPresentationIntent {
	nonce: number;
	plan: string;
	source: PlanCompletionSource;
}

const PLAN_COMMAND_COMPLETIONS: readonly CommandArgumentCompletion[] = [
	{ value: "show", label: "show", description: "Show the completed plan" },
	{ value: "finalize", label: "finalize", description: "Request a completed plan" },
	{ value: "implement", label: "implement", description: "Implement the completed plan" },
	{ value: "exit", label: "exit", description: "Leave Plan mode" },
	{ value: "off", label: "off", description: "Leave Plan mode" },
];

export default function planMode(pi: ExtensionAPI) {
	let state: PlanModeState = { enabled: false, awaitingAction: false };
	let settings: PlanModeSettings = { thinkingLevel: "inherit" };
	let previousTools: string[] | undefined;
	let acquiredPlanGate: SubagentPlanGate | undefined;
	let readyPresentationIntent: ReadyPresentationIntent | undefined;
	let nextReadyPresentationNonce = 0;

	pi.registerFlag("plan", {
		description: "Start in Codex-like Plan mode",
		type: "boolean",
		default: false,
	});

	pi.registerTool({
		name: PLAN_MODE_QUESTION_TOOL_NAME,
		label: "Plan question",
		description:
			"Ask the user one to three Plan-mode clarification questions with meaningful options, then wait for the answer. Only available while Plan mode is active.",
		promptSnippet: "Ask user decision questions while Plan mode is active",
		promptGuidelines: [
			"In Plan mode, use plan_mode_question for important preferences, tradeoffs, or assumptions that cannot be discovered from read-only exploration.",
		],
		parameters: PLAN_MODE_QUESTION_PARAMS,
		async execute(_toolCallId, params: unknown, _signal, _onUpdate, ctx) {
			if (!state.enabled) {
				return planModeQuestionCancelled(
					[],
					"plan_mode_inactive",
					"Error: plan_mode_question is only available while Plan mode is active.",
				);
			}

			const parsed = normalizePlanModeQuestionParams(params);
			if (!parsed.ok) {
				return planModeQuestionCancelled([], "invalid_input", `Error: ${parsed.error}`);
			}

			if (!ctx.hasUI) {
				return planModeQuestionCancelled(
					parsed.questions,
					"ui_unavailable",
					"Unable to ask Plan-mode questions because interactive UI is not available.",
				);
			}

			const answers = await askPlanModeQuestions(parsed.questions, ctx);
			if (!answers) {
				return planModeQuestionCancelled(
					parsed.questions,
					"cancelled",
					"User cancelled the Plan-mode question prompt.",
				);
			}

			return planModeQuestionAnswered(parsed.questions, answers);
		},
	});

	pi.registerTool({
		name: PLAN_MODE_COMPLETE_TOOL_NAME,
		label: "Complete plan",
		description:
			"Submit a structured, decision-ready implementation plan for validation and user review. Each requirement must include its implementation approach and acceptance checks. Only available while Plan mode is active, and must be the final standalone action.",
		promptSnippet: "Submit the final Plan-mode implementation plan",
		promptGuidelines: [
			"Call plan_mode_complete alone as the final action only after every requirement has an implementation approach and acceptance checks.",
		],
		parameters: PLAN_MODE_COMPLETE_PARAMS,
		async execute(_toolCallId, params: unknown, _signal, _onUpdate, ctx) {
			if (!state.enabled) {
				throw new Error("plan_mode_complete is only available while Plan mode is active");
			}
			const parsed = normalizePlanModeCompletion(params);
			if (!parsed.ok) throw new Error(parsed.error);

			acceptCompletedPlan(parsed.plan, PLAN_MODE_COMPLETE_TOOL_NAME, ctx);
			return planModeCompleted(parsed.plan);
		},
	});

	pi.registerCommand("plan", {
		description: "Enter or manage Codex-like Plan mode",
		getArgumentCompletions: completePlanArguments,
		handler: async (args, ctx) => {
			const prompt = args.trim();
			const command = prompt.toLowerCase();
			if (command === "show") {
				showStoredPlan(ctx);
				return;
			}
			if (command === "finalize") {
				requestFinalPlan(ctx);
				return;
			}
			if (command === "implement") {
				if (!state.enabled || !state.latestPlan?.trim()) {
					ctx.ui.notify("No completed plan is available to implement.", "warning");
					return;
				}
				startImplementation(ctx);
				return;
			}
			if (command === "exit" || command === "off") {
				exitPlanMode(ctx);
				ctx.ui.notify("Plan mode disabled. Proposed plan discarded.", "info");
				return;
			}
			if (prompt) {
				enterPlanModeWithPrompt(prompt, ctx);
				return;
			}
			if (!state.enabled) {
				if (!enterPlanMode(ctx)) return;
				ctx.ui.notify("Plan mode enabled. I will explore and plan, but not modify files.", "info");
				return;
			}
			await showPlanMenu(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		releasePlanGate();
		readyPresentationIntent = undefined;
		settings = { thinkingLevel: "inherit" };
		const loadedSettings = await readPlanModeSettings();
		if (loadedSettings.kind === "loaded") settings = loadedSettings.settings;
		else if (loadedSettings.kind === "invalid") {
			ctx.ui.notify(`pi-plan-mode settings ignored: ${loadedSettings.reason}`, "warning");
		}
		if (loadedSettings.notice) ctx.ui.notify(loadedSettings.notice, "warning");
		restoreState(ctx);
		if (pi.getFlag("plan") === true) state.enabled = true;
		if (state.enabled) {
			if (acquirePlanGate()) {
				activatePlanModeTools();
				applyPlanThinkingLevel();
			} else {
				state = {
					...state,
					enabled: false,
					latestPlan: undefined,
					latestPlanSource: undefined,
					awaitingAction: false,
					manualThinkingLevel: undefined,
				};
				deactivatePlanModeQuestionTool();
				persistState();
				ctx.ui.notify(
					"Plan mode was not restored because a SubAgent is running or queued. Wait for it to finish or stop it first.",
					"warning",
				);
			}
		} else deactivatePlanModeQuestionTool();
		updateUi(ctx);
	});

	pi.on("thinking_level_select", (event) => {
		if (!state.enabled || !state.appliedThinkingLevel) return;
		if (event.level !== state.appliedThinkingLevel) {
			state = {
				...state,
				manualThinkingLevel: event.level,
				previousThinkingLevel: undefined,
				appliedThinkingLevel: undefined,
			};
			persistState();
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		readyPresentationIntent = undefined;
		captureManualThinkingLevel();
		persistState();
		if (state.enabled) {
			restoreTools();
			restoreThinkingLevel();
		}
		releasePlanGate();
		clearUi(ctx);
	});

	pi.on("tool_call", async (event) => {
		if (!state.enabled) return;
		if (ALLOWED_PLAN_TOOLS.has(event.toolName)) return;
		return {
			block: true,
			reason: `Plan mode blocks tool '${event.toolName}' because it is outside the fixed Plan-mode tool set.`,
		};
	});

	pi.on("context", async (event) => {
		const messagesWithoutLegacyPlanContext = event.messages.filter(
			(message: unknown) => !messageContainsLegacyPlanModeContextArtifact(message),
		);
		if (state.enabled) {
			return {
				messages: messagesWithoutLegacyPlanContext.filter(
					(message: unknown) => !messageContainsPlanModeImplementationHandoff(message),
				),
			};
		}
		return {
			messages: messagesWithoutLegacyPlanContext
				.filter((message: unknown) => !messageContainsInactivePlanModeArtifact(message))
				.map(stripProposedPlanBlocksFromMessage)
				.map(stripPlanModeCompletionCallsFromMessage)
				.filter((message: unknown) => !isEmptyAssistantMessage(message)),
		};
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!state.enabled) return;
		if (state.latestPlan || state.awaitingAction) {
			readyPresentationIntent = undefined;
			state = {
				...state,
				latestPlan: undefined,
				latestPlanSource: undefined,
				awaitingAction: false,
			};
			persistState();
			updateUi(ctx);
		}
		applyPlanModeTools();
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildPlanModePrompt()}`,
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!state.enabled) return;

		const text = latestAssistantText(event.messages);
		const parsedPlan = parseProposedPlan(text);
		if (parsedPlan.kind !== "valid") {
			if (parsedPlan.kind !== "absent") {
				ctx.ui.notify(invalidPlanMessage(parsedPlan.kind), "warning");
			}
			persistState();
			updateUi(ctx);
			return;
		}
		acceptCompletedPlan(parsedPlan.plan, "legacy_proposed_plan", ctx);
	});

	onAgentSettled(pi, async (_event, ctx) => {
		const intent = readyPresentationIntent;
		if (!intent || !readyPresentationIsCurrent(intent)) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

		readyPresentationIntent = undefined;
		try {
			if (intent.source === "legacy_proposed_plan") {
				pi.sendMessage(
					{
						customType: PROPOSED_PLAN_MESSAGE_TYPE,
						content: `**Proposed Plan**\n\n${intent.plan}`,
						display: true,
					},
					{ triggerTurn: false },
				);
			}
			if (ctx.hasUI && completedPlanIsCurrent(intent)) {
				await showPlanReadyMenu(ctx);
			}
		} catch (error: unknown) {
			if (!isStaleExtensionContextError(error)) throw error;
		}
	});

	function enterPlanMode(ctx: ExtensionContext): boolean {
		if (!state.enabled && !acquirePlanGate()) {
			ctx.ui.notify(
				"Cannot enter Plan mode while a SubAgent is running or queued. Wait for it to finish or stop it first.",
				"warning",
			);
			return false;
		}
		if (!state.enabled) previousTools = withoutRequiredPlanModeTools(safeGetActiveTools());
		state = { ...state, enabled: true, awaitingAction: false };
		activatePlanModeTools();
		applyPlanThinkingLevel();
		persistState();
		updateUi(ctx);
		return true;
	}

	function enterPlanModeWithPrompt(prompt: string, ctx: ExtensionContext) {
		const wasEnabled = state.enabled;
		if (!enterPlanMode(ctx)) return;
		if (!wasEnabled) {
			ctx.ui.notify("Plan mode enabled. I will explore and plan, but not modify files.", "info");
		}
		if (!sendPlanModeUserMessage(prompt, ctx) && !wasEnabled) exitPlanMode(ctx);
	}

	function exitPlanMode(ctx: ExtensionContext) {
		const wasEnabled = state.enabled;
		readyPresentationIntent = undefined;
		state = {
			...state,
			enabled: false,
			latestPlan: undefined,
			latestPlanSource: undefined,
			awaitingAction: false,
			manualThinkingLevel: undefined,
		};
		if (wasEnabled) {
			restoreTools();
			restoreThinkingLevel();
			state = { ...state, manualThinkingLevel: undefined };
		}
		releasePlanGate();
		persistState();
		updateUi(ctx);
	}

	function sendPlanModeUserMessage(message: string, ctx: ExtensionContext) {
		try {
			if (ctx.isIdle()) pi.sendUserMessage(message);
			else pi.sendUserMessage(message, { deliverAs: "followUp" });
			return true;
		} catch (error: unknown) {
			const detail = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Unable to send Plan-mode message: ${detail}`, "error");
			return false;
		}
	}

	function acceptCompletedPlan(plan: string, source: PlanCompletionSource, ctx: ExtensionContext) {
		if (state.enabled && state.awaitingAction && state.latestPlan === plan && state.latestPlanSource === source) {
			return;
		}
		state = {
			...state,
			latestPlan: plan,
			latestPlanSource: source,
			awaitingAction: true,
		};
		readyPresentationIntent = {
			nonce: ++nextReadyPresentationNonce,
			plan,
			source,
		};
		persistState();
		updateUi(ctx);
	}

	function completedPlanIsCurrent(intent: ReadyPresentationIntent) {
		return (
			state.enabled &&
			state.awaitingAction &&
			state.latestPlan === intent.plan &&
			state.latestPlanSource === intent.source
		);
	}

	function readyPresentationIsCurrent(intent: ReadyPresentationIntent) {
		return completedPlanIsCurrent(intent) && readyPresentationIntent?.nonce === intent.nonce;
	}

	function showStoredPlan(ctx: ExtensionContext) {
		const plan = state.latestPlan?.trim();
		if (!state.enabled || !plan) {
			ctx.ui.notify("No completed plan is available. Use /plan finalize when planning is complete.", "info");
			return;
		}
		try {
			pi.sendMessage(
				{
					customType: PROPOSED_PLAN_MESSAGE_TYPE,
					content: `**Proposed Plan**\n\n${plan}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		} catch (error: unknown) {
			const detail = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Unable to show completed plan: ${detail}`, "error");
		}
	}

	function requestFinalPlan(ctx: ExtensionContext) {
		if (!state.enabled) {
			ctx.ui.notify("Plan mode is not active. Use /plan first.", "warning");
			return;
		}
		sendPlanModeUserMessage(
			"Finalize the current implementation plan now. If any material decision remains, use plan_mode_question instead. Otherwise call plan_mode_complete alone as your final action with the complete decision-ready plan.",
			ctx,
		);
	}

	function startImplementation(ctx: ExtensionContext) {
		const plan = state.latestPlan?.trim();
		const source = state.latestPlanSource;
		exitPlanMode(ctx);

		if (!plan) {
			ctx.ui.notify("Plan mode disabled. No proposed plan is available to implement.", "warning");
			return;
		}

		const sent = sendPlanModeUserMessage(
			`Plan mode is now disabled. Full tool access is restored. Implement this proposed plan now:\n\n${plan}`,
			ctx,
		);
		if (!sent) {
			enterPlanMode(ctx);
			state = { ...state, latestPlan: plan, latestPlanSource: source, awaitingAction: true };
			persistState();
			updateUi(ctx);
		}
	}

	async function showPlanMenu(ctx: ExtensionContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify(planStatusText(), "info");
			return;
		}

		const choices = state.latestPlan
			? ["Show latest proposed plan", IMPLEMENT_PLAN_CHOICE, CONTINUE_PLANNING_CHOICE, DISCARD_PLAN_CHOICE]
			: ["Request final plan", "Stay in Plan mode", "Exit Plan mode"];
		const choice = await ctx.ui.select(planStatusText(), choices);
		if (choice === "Show latest proposed plan") {
			showStoredPlan(ctx);
			return;
		}
		if (choice === "Request final plan") {
			requestFinalPlan(ctx);
			return;
		}
		if (choice === IMPLEMENT_PLAN_CHOICE) {
			startImplementation(ctx);
			return;
		}
		if (choice === DISCARD_PLAN_CHOICE) {
			exitPlanMode(ctx);
			ctx.ui.notify("Plan mode disabled. Proposed plan discarded.", "info");
			return;
		}
		updateUi(ctx);
	}

	async function showPlanReadyMenu(ctx: ExtensionContext) {
		const choice = await ctx.ui.select("Proposed plan ready. What next?", [
			IMPLEMENT_PLAN_CHOICE,
			CONTINUE_PLANNING_CHOICE,
			DISCARD_PLAN_CHOICE,
		]);
		if (choice === IMPLEMENT_PLAN_CHOICE) {
			startImplementation(ctx);
			return;
		}
		if (choice === DISCARD_PLAN_CHOICE) {
			exitPlanMode(ctx);
			ctx.ui.notify("Plan mode disabled. Proposed plan discarded.", "info");
		}
	}

	function activatePlanModeTools() {
		previousTools ??= withoutRequiredPlanModeTools(safeGetActiveTools());
		applyPlanModeTools();
	}

	function applyPlanModeTools() {
		pi.setActiveTools(planModeToolNames());
	}

	function planModeToolNames() {
		const tools = safeGetAllTools();
		if (tools.length === 0) {
			return ["read", "bash", PLAN_MODE_QUESTION_TOOL_NAME, PLAN_MODE_COMPLETE_TOOL_NAME];
		}
		const availableNames = new Set(tools.map((tool) => tool.name));
		return withRequiredPlanModeTools(FIXED_PLAN_TOOLS.filter((name) => availableNames.has(name)));
	}

	function safeGetAllTools() {
		try {
			return pi.getAllTools();
		} catch {
			return [];
		}
	}

	function acquirePlanGate() {
		if (acquiredPlanGate) return true;
		const gate = subagentPlanGate();
		if (!gate) return true;
		try {
			if (gate.tryEnterPlanMode() !== "entered") return false;
			acquiredPlanGate = gate;
			return true;
		} catch {
			return false;
		}
	}

	function releasePlanGate() {
		const gate = acquiredPlanGate;
		acquiredPlanGate = undefined;
		if (!gate) return;
		try {
			gate.exitPlanMode();
		} catch {
			// The SubAgent extension may already be shutting down.
		}
	}

	function restoreTools() {
		const restoredTools = previousTools ?? DEFAULT_TOOLS;
		pi.setActiveTools(withoutRequiredPlanModeTools(restoredTools));
		previousTools = undefined;
	}

	function applyPlanThinkingLevel() {
		if (state.manualThinkingLevel) {
			if (pi.getThinkingLevel() !== state.manualThinkingLevel) {
				setPlanThinkingLevel(pi, state.manualThinkingLevel);
			}
			return;
		}
		const configured = configuredThinkingLevel(settings);
		if (!configured) {
			state = {
				...state,
				previousThinkingLevel: undefined,
				appliedThinkingLevel: undefined,
			};
			return;
		}
		const current = pi.getThinkingLevel();
		if (!state.appliedThinkingLevel) state.previousThinkingLevel = current;
		if (current !== configured) setPlanThinkingLevel(pi, configured);
		state.appliedThinkingLevel = pi.getThinkingLevel();
	}

	function captureManualThinkingLevel() {
		if (!state.appliedThinkingLevel) return;
		const current = pi.getThinkingLevel();
		if (current === state.appliedThinkingLevel) return;
		state = {
			...state,
			manualThinkingLevel: current,
			previousThinkingLevel: undefined,
			appliedThinkingLevel: undefined,
		};
	}

	function restoreThinkingLevel() {
		captureManualThinkingLevel();
		const { appliedThinkingLevel, previousThinkingLevel } = state;
		if (appliedThinkingLevel && previousThinkingLevel && pi.getThinkingLevel() === appliedThinkingLevel) {
			setPlanThinkingLevel(pi, previousThinkingLevel);
		}
		state = { ...state, appliedThinkingLevel: undefined, previousThinkingLevel: undefined };
	}

	function deactivatePlanModeQuestionTool() {
		const activeTools = safeGetActiveTools();
		const filteredTools = withoutRequiredPlanModeTools(activeTools);
		if (filteredTools.length !== activeTools.length) {
			pi.setActiveTools(filteredTools);
		}
	}

	function safeGetActiveTools() {
		try {
			return pi.getActiveTools();
		} catch {
			return DEFAULT_TOOLS;
		}
	}

	function persistState() {
		pi.appendEntry<PlanModeState>(STATE_ENTRY_TYPE, state);
	}

	function restoreState(ctx: ExtensionContext) {
		state = restorePlanModeState(ctx.sessionManager.getBranch(), STATE_ENTRY_TYPE);
	}

	function updateUi(ctx: ExtensionContext) {
		ctx.ui.setStatus(STATUS_KEY, formatStatus());
		if (state.enabled && state.latestPlan) {
			ctx.ui.setWidget(PLAN_WIDGET_KEY, [
				"Proposed plan ready",
				"Use /plan to implement, revise, or exit Plan mode.",
			]);
		} else if (state.enabled) {
			ctx.ui.setWidget(PLAN_WIDGET_KEY, [
				"Plan mode: planning",
				formatToolSummary(),
				"Finish with plan_mode_complete when decision-ready.",
			]);
		} else {
			ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
		}
	}

	function formatStatus() {
		if (!state.enabled) return undefined;
		if (state.awaitingAction || state.latestPlan) return "plan ready";
		return "plan active";
	}

	function clearUi(ctx: ExtensionContext) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
	}

	function planStatusText() {
		if (!state.enabled) return "Plan mode is off.";
		if (state.latestPlan) return `Plan mode is active and a proposed plan is ready. ${formatToolSummary()}`;
		return `Plan mode is active. ${formatToolSummary()} Explore, ask, and finish with plan_mode_complete when decision-ready.`;
	}

	function formatToolSummary() {
		const names = planModeToolNames();
		return `Tools: ${names.length > 0 ? names.join(", ") : "none"}`;
	}
}

function subagentPlanGate(): SubagentPlanGate | undefined {
	const candidate = (globalThis as Record<symbol, unknown>)[SUBAGENT_MANAGER_KEY];
	if (!candidate || typeof candidate !== "object") return undefined;
	const gate = candidate as Partial<SubagentPlanGate>;
	if (typeof gate.tryEnterPlanMode !== "function" || typeof gate.exitPlanMode !== "function") return undefined;
	return gate as SubagentPlanGate;
}

export function completePlanArguments(argumentPrefix: string): CommandArgumentCompletion[] | null {
	const prefix = argumentPrefix.trimStart().toLowerCase();
	if (prefix === "") return [...PLAN_COMMAND_COMPLETIONS];
	if (/\s/.test(prefix)) return null;

	const matches = PLAN_COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(prefix));
	return matches.length > 0 ? [...matches] : null;
}

function unique(values: string[]) {
	return Array.from(new Set(values));
}

function isStaleExtensionContextError(error: unknown) {
	return (
		error instanceof Error &&
		(error.message.includes("This extension ctx is stale after session replacement or reload") ||
			error.message.includes("Extension context is no longer active"))
	);
}

export function withRequiredPlanModeTools(toolNames: string[]) {
	return unique([
		...withoutRequiredPlanModeTools(toolNames),
		PLAN_MODE_QUESTION_TOOL_NAME,
		PLAN_MODE_COMPLETE_TOOL_NAME,
	]);
}

function withoutRequiredPlanModeTools(toolNames: string[]) {
	return toolNames.filter(
		(toolName) => toolName !== PLAN_MODE_QUESTION_TOOL_NAME && toolName !== PLAN_MODE_COMPLETE_TOOL_NAME,
	);
}

function invalidPlanMessage(kind: "empty" | "multiple" | "malformed" | "unclosed") {
	const detail = {
		empty: "the block is empty",
		multiple: "more than one plan block was produced",
		malformed: "the tags must be on their own lines",
		unclosed: "the closing tag is missing",
	}[kind];
	return `Proposed plan is not ready: ${detail}. Continue Plan mode and produce one complete non-empty <proposed_plan> block.`;
}

export {
	extractProposedPlan,
	latestAssistantText,
	parseProposedPlan,
	stripProposedPlanBlocks,
	stripProposedPlanBlocksFromMessage,
} from "./message-transform.ts";
export { buildPlanModePrompt } from "./prompt.ts";
export { normalizePlanModeQuestionParams } from "./question-tool.ts";
export { normalizePlanModeSettings, readPlanModeSettings } from "./settings.ts";
