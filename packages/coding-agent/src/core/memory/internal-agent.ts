import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";

export function toInternalAgentTools(definitions: readonly ToolDefinition[]): AgentTool[] {
	return definitions.map((definition) => ({
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		executionMode: definition.executionMode,
		execute: (toolCallId, params, signal, onUpdate) =>
			definition.execute(toolCallId, params, signal, onUpdate, {} as never),
	}));
}

export interface InternalAgentTransport {
	streamFn: Agent["streamFn"];
	convertToLlm: Agent["convertToLlm"];
	getApiKey: Agent["getApiKey"];
	transport: Agent["transport"];
	thinkingBudgets: Agent["thinkingBudgets"];
	maxRetryDelayMs: Agent["maxRetryDelayMs"];
}

export function internalAgentTransport(parent: Agent): InternalAgentTransport {
	return {
		streamFn: parent.streamFn,
		convertToLlm: parent.convertToLlm,
		getApiKey: parent.getApiKey,
		transport: parent.transport,
		thinkingBudgets: parent.thinkingBudgets,
		maxRetryDelayMs: parent.maxRetryDelayMs,
	};
}
