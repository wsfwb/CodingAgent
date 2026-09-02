import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquireMemoryScopeLock,
	MemoryMarkdownStore,
	type MemoryTopicDocument,
	parseMemoryTopic,
	renderMemoryTopic,
} from "../../src/core/memory/index.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-memory-store-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function topicDocument(revision = 1): MemoryTopicDocument {
	return {
		schemaVersion: 1,
		scope: "global",
		topic: "preferences",
		topicRevision: revision,
		entries: [
			{
				schemaVersion: 1,
				key: "response-language",
				title: "Response language",
				summary: "Use Chinese by default.",
				content: "Use Chinese by default while preserving technical identifiers.",
				source: "user_explicit",
				createdAt: "2026-07-18T00:00:00.000Z",
				observedAt: "2026-07-18T00:00:00.000Z",
				updatedAt: "2026-07-18T00:00:00.000Z",
				sourceSessionId: "session-1",
			},
		],
	};
}

describe("MemoryMarkdownStore", () => {
	it("round trips a managed topic document", () => {
		expect(parseMemoryTopic(renderMemoryTopic(topicDocument()))).toEqual(topicDocument());
	});

	it("rejects duplicate keys in one scope topic", () => {
		const rendered = renderMemoryTopic({
			...topicDocument(),
			entries: [topicDocument().entries[0], topicDocument().entries[0]],
		});
		expect(() => parseMemoryTopic(rendered)).toThrow("duplicate memory key");
	});

	it("rebuilds a stale derived index from topic documents", async () => {
		const agentDir = await temporaryDirectory();
		const store = new MemoryMarkdownStore(agentDir, "C:/work/project", "global");
		await store.writeTopicAndIndex(topicDocument());
		const staleIndex = await readFile(store.indexPath, "utf8");
		await store.writeTopicAndIndex(topicDocument(2));
		await import("node:fs/promises").then(({ writeFile }) => writeFile(store.indexPath, staleIndex));

		const loaded = await store.loadConsistentIndex(new Date("2026-07-18T01:00:00.000Z"), {
			persistRebuild: true,
		});
		expect(loaded.rebuilt).toBe(true);
		expect(loaded.index.topics.find((topic) => topic.topic === "preferences")?.topicRevision).toBe(2);
		expect(loaded.content).toContain("response-language");
	});

	it("uses only a temporary lock directory and releases it", async () => {
		const agentDir = await temporaryDirectory();
		const store = new MemoryMarkdownStore(agentDir, "C:/work/project", "global");
		const release = await acquireMemoryScopeLock(store.scopeDirectory);
		await access(join(store.scopeDirectory, "write-memory.lock"));
		await release();
		await expect(access(join(store.scopeDirectory, "write-memory.lock"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(access(join(store.scopeDirectory, "write-memory"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("writes and verifies project identity metadata", async () => {
		const agentDir = await temporaryDirectory();
		const store = new MemoryMarkdownStore(agentDir, "C:/work/project", "project");
		await store.ensureProjectMetadata(new Date("2026-07-18T00:00:00.000Z"));
		const metadata = JSON.parse(await readFile(join(store.scopeDirectory, "project.json"), "utf8"));
		expect(metadata).toMatchObject({ schemaVersion: 1, createdAt: "2026-07-18T00:00:00.000Z" });
	});
});
