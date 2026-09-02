import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { MemoryManager, MemoryMutationResult } from "./manager.ts";

const scopeSchema = Type.Union([Type.Literal("global"), Type.Literal("project")]);
const topicSchema = Type.Union([
	Type.Literal("preferences"),
	Type.Literal("conventions"),
	Type.Literal("architecture"),
	Type.Literal("workflows"),
	Type.Literal("debugging"),
]);
const readSchema = Type.Object({ scope: scopeSchema, topic: topicSchema });
const forgetSchema = Type.Object({
	scope: scopeSchema,
	topic: topicSchema,
	key: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
	reason: Type.Union([Type.Literal("user_request"), Type.Literal("superseded")], {
		description: "Delete only on an explicit forget request or when a new explicit instruction replaces this key",
	}),
});

export interface CreateMemoryToolDefinitionsOptions {
	manager: MemoryManager;
	sessionId: string;
	canUseProjectMemory: () => boolean;
	onMutation?: (mutation: MemoryMutationResult) => void;
}

function assertScopeAllowed(scope: "global" | "project", canUseProjectMemory: () => boolean): void {
	if (scope === "project" && !canUseProjectMemory()) {
		throw new Error("project memory is unavailable because this project is not trusted");
	}
}

export function createMemoryToolDefinitions(options: CreateMemoryToolDefinitionsOptions): ToolDefinition[] {
	const sourceSchema = Type.Union([
		Type.Literal("user_explicit"),
		Type.Literal("user_feedback"),
		Type.Literal("verified_project_fact"),
	]);
	const writeSchema = Type.Object({
		scope: scopeSchema,
		topic: topicSchema,
		key: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
		title: Type.String({ minLength: 1, maxLength: 120 }),
		summary: Type.String({ minLength: 1, maxLength: 256 }),
		content: Type.String({ minLength: 1, maxLength: 4096 }),
		source: sourceSchema,
	});
	const mutationResult = (result: MemoryMutationResult) => {
		options.onMutation?.(result);
		return {
			content: [
				{
					type: "text" as const,
					text: `${result.action} ${result.scope} memory ${result.key} in ${result.topic} (topic revision ${result.topicRevision})`,
				},
			],
			details: result,
		};
	};

	return [
		{
			name: "memory_read",
			label: "read memory topic",
			description:
				"Read every managed entry in one fixed memory topic after its MEMORY.md index indicates that full details are relevant. This does not search session history.",
			promptSnippet: "Read the complete contents of one indexed long-term memory topic",
			parameters: readSchema,
			executionMode: "parallel",
			async execute(_toolCallId, input) {
				const params = input as Static<typeof readSchema>;
				assertScopeAllowed(params.scope, options.canUseProjectMemory);
				const document = await options.manager.read(params.scope, params.topic);
				return { content: [{ type: "text", text: JSON.stringify(document, null, 2) }], details: document };
			},
		},
		{
			name: "memory_create",
			label: "create memory",
			description:
				"Create a durable memory only when its key is absent. Preserve explicit long-term instructions, durable user feedback, and reusable project facts verified by direct tool evidence. Use global only for cross-project user preferences/workflows; verified project facts must use project scope. Read the relevant topic first when the index is insufficient to rule out duplication.",
			promptSnippet: "Create a new durable memory after checking its evidence and index/topic",
			promptGuidelines: [
				"During normal task reasoning, use memory tools for explicit long-term instructions and durable implicit user feedback; before the final answer, also preserve reusable project facts only when this run directly verified them through successful reads, commands, or tests",
				"Do not create memory for temporary requests, tentative ideas, facts easily recovered from project files, unverified model or subagent claims, or when this task produced no durable information",
				"Use source=user_explicit for explicit long-term instructions, user_feedback for durable corrections or preferences inferred from user feedback, and verified_project_fact only with direct evidence from this run and only in project scope",
				"Never claim memory was saved without a successful memory tool result",
				"Before memory_create, use the loaded index and memory_read when necessary to avoid semantic duplicates; use memory_update for an existing key",
			],
			parameters: writeSchema,
			executionMode: "sequential",
			async execute(_toolCallId, input) {
				const params = input as Static<typeof writeSchema>;
				assertScopeAllowed(params.scope, options.canUseProjectMemory);
				return mutationResult(
					await options.manager.create(params.scope, params.topic, {
						...params,
						sourceSessionId: options.sessionId,
					}),
				);
			},
		},
		{
			name: "memory_update",
			label: "update memory",
			description:
				"Replace an existing durable memory with newer reliable evidence, including explicit instructions, durable feedback, or a directly verified project fact. This preserves the original creation time.",
			promptSnippet: "Update an existing durable memory by stable key",
			parameters: writeSchema,
			executionMode: "sequential",
			async execute(_toolCallId, input) {
				const params = input as Static<typeof writeSchema>;
				assertScopeAllowed(params.scope, options.canUseProjectMemory);
				return mutationResult(
					await options.manager.update(params.scope, params.topic, {
						...params,
						sourceSessionId: options.sessionId,
					}),
				);
			},
		},
		{
			name: "memory_forget",
			label: "forget memory",
			description:
				"Delete one exact indexed memory key only because the user explicitly asked to forget it or a new explicit instruction supersedes it. Read the topic first if the requested key is ambiguous; ask the user if multiple candidates remain.",
			promptSnippet: "Delete one exact memory key after explicit forget or replacement",
			parameters: forgetSchema,
			executionMode: "sequential",
			async execute(_toolCallId, input) {
				const params = input as Static<typeof forgetSchema>;
				assertScopeAllowed(params.scope, options.canUseProjectMemory);
				return mutationResult(await options.manager.forget(params.scope, params.topic, params.key));
			},
		},
	];
}
