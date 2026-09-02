import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { MemoryScope, MemoryTopic } from "./types.ts";

export const GLOBAL_MEMORY_TOPICS = ["preferences", "workflows"] as const;
export const PROJECT_MEMORY_TOPICS = ["conventions", "architecture", "workflows", "debugging"] as const;
export const MEMORY_INDEX_FILE = "MEMORY.md";
export const MEMORY_PROJECT_FILE = "project.json";

export function normalizeMemoryProjectRoot(projectRoot: string): string {
	const normalized = resolve(projectRoot).replace(/\\/g, "/").replace(/\/$/, "");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function createMemoryProjectId(projectRoot: string): string {
	return createHash("sha256").update(normalizeMemoryProjectRoot(projectRoot)).digest("hex").slice(0, 24);
}

export function getMemoryRoot(agentDir: string): string {
	return join(agentDir, "memory");
}

export function getMemoryScopeDirectory(agentDir: string, scope: MemoryScope, projectRoot: string): string {
	if (scope === "global") return join(getMemoryRoot(agentDir), "global");
	return join(getMemoryRoot(agentDir), "projects", createMemoryProjectId(projectRoot));
}

export function getMemoryTopics(scope: MemoryScope): readonly MemoryTopic[] {
	return scope === "global" ? GLOBAL_MEMORY_TOPICS : PROJECT_MEMORY_TOPICS;
}

export function isMemoryTopicForScope(scope: MemoryScope, topic: string): topic is MemoryTopic {
	return getMemoryTopics(scope).includes(topic as MemoryTopic);
}
