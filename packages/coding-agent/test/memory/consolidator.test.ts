import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { AgentMemoryConsolidator, type MemoryTopicDocument } from "../../src/core/memory/index.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("unexpected stream event");
			},
		);
	}
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AgentMemoryConsolidator", () => {
	it("accepts structured reduced entries without changing provenance", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const parentAgent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "main", tools: [] },
			streamFn: async (_model, context) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const hasToolResult = context.messages.some((message) => message.role === "toolResult");
					const message = hasToolResult
						? assistant([{ type: "text", text: "done" }])
						: assistant([
								{
									type: "toolCall",
									id: "consolidate-1",
									name: "submit_memory_consolidation",
									arguments: {
										entries: [
											{
												key: "response-language",
												title: "Response language",
												summary: "Use Chinese.",
												content: "Use Chinese by default.",
											},
										],
									},
								},
							]);
					stream.push({ type: "start", partial: { ...message, content: [] } });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		const document: MemoryTopicDocument = {
			schemaVersion: 1,
			scope: "global",
			topic: "preferences",
			topicRevision: 3,
			entries: [
				{
					schemaVersion: 1,
					key: "response-language",
					title: "Response language and technical names",
					summary: "Use Chinese while retaining technical identifiers.",
					content: "Use Chinese by default. Keep API names and identifiers in their original spelling.",
					source: "user_explicit",
					createdAt: "2026-07-18T00:00:00.000Z",
					observedAt: "2026-07-18T00:00:00.000Z",
					updatedAt: "2026-07-18T00:00:00.000Z",
				},
			],
		};
		const result = await new AgentMemoryConsolidator(parentAgent).consolidate({
			document,
			protectedKeys: ["response-language"],
			targetBytes: 1_000,
		});
		expect(result.entries[0]).toMatchObject({
			key: "response-language",
			summary: "Use Chinese.",
			source: "user_explicit",
			observedAt: "2026-07-18T00:00:00.000Z",
		});
	});
});
