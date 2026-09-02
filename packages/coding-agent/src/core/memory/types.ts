export const MEMORY_SCHEMA_VERSION = 1 as const;

export type MemoryScope = "global" | "project";
export type GlobalMemoryTopic = "preferences" | "workflows";
export type ProjectMemoryTopic = "conventions" | "architecture" | "workflows" | "debugging";
export type MemoryTopic = GlobalMemoryTopic | ProjectMemoryTopic;
export type MemorySource = "user_explicit" | "user_feedback" | "verified_project_fact";

export interface MemoryEntry {
	schemaVersion: typeof MEMORY_SCHEMA_VERSION;
	key: string;
	title: string;
	summary: string;
	content: string;
	source: MemorySource;
	createdAt: string;
	observedAt: string;
	updatedAt: string;
	sourceSessionId?: string;
}

export interface MemoryTopicDocument {
	schemaVersion: typeof MEMORY_SCHEMA_VERSION;
	scope: MemoryScope;
	topic: MemoryTopic;
	topicRevision: number;
	entries: MemoryEntry[];
}

export interface MemoryIndexTopic {
	topic: MemoryTopic;
	topicRevision: number;
	entries: Array<Pick<MemoryEntry, "key" | "summary" | "source" | "observedAt">>;
}

export interface MemoryIndex {
	schemaVersion: typeof MEMORY_SCHEMA_VERSION;
	scope: MemoryScope;
	generatedAt: string;
	topics: MemoryIndexTopic[];
}
