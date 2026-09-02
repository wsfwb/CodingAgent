import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildAutoMemoryPrompt,
	createMemoryToolDefinitions,
	MemoryManager,
	type MemoryMutationResult,
} from "../../src/core/memory/index.ts";

const directories: string[] = [];
async function tempDir(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pi-memory-tools-"));
	directories.push(path);
	return path;
}
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function writeInput(scope: "global" | "project" = "global") {
	return {
		scope,
		topic: scope === "global" ? ("preferences" as const) : ("conventions" as const),
		key: "response-language",
		title: "Response language",
		summary: "Use Chinese by default.",
		content: "Use Chinese by default while preserving technical identifiers.",
		source: "user_explicit" as const,
	};
}

describe("memory tools", () => {
	it("creates and reads managed memory while reporting the mutation", async () => {
		const manager = new MemoryManager({ agentDir: await tempDir(), projectRoot: "C:/work/project" });
		const mutations: MemoryMutationResult[] = [];
		const tools = createMemoryToolDefinitions({
			manager,
			sessionId: "session-1",
			canUseProjectMemory: () => true,
			onMutation: (mutation) => mutations.push(mutation),
		});
		const create = tools.find((tool) => tool.name === "memory_create");
		const read = tools.find((tool) => tool.name === "memory_read");
		await create?.execute("create-1", writeInput(), undefined, undefined, {} as never);
		const result = await read?.execute(
			"read-1",
			{ scope: "global", topic: "preferences" },
			undefined,
			undefined,
			{} as never,
		);

		expect(mutations).toMatchObject([{ action: "created", key: "response-language" }]);
		expect(result?.content[0]).toMatchObject({ type: "text" });
		expect(JSON.stringify(result?.details)).toContain("session-1");
	});

	it("rejects project memory when the project is untrusted", async () => {
		const manager = new MemoryManager({ agentDir: await tempDir(), projectRoot: "C:/work/project" });
		const create = createMemoryToolDefinitions({
			manager,
			sessionId: "session-1",
			canUseProjectMemory: () => false,
		}).find((tool) => tool.name === "memory_create");
		await expect(
			create?.execute("create-1", writeInput("project"), undefined, undefined, {} as never),
		).rejects.toThrow("project is not trusted");
	});

	it("lets the main agent preserve verified project facts but not global facts", async () => {
		const manager = new MemoryManager({ agentDir: await tempDir(), projectRoot: "C:/work/project" });
		const create = createMemoryToolDefinitions({
			manager,
			sessionId: "session-1",
			canUseProjectMemory: () => true,
		}).find((tool) => tool.name === "memory_create");
		const verifiedFact = {
			...writeInput("project"),
			key: "focused-test-command",
			title: "Focused test command",
			summary: "Run the package Vitest command for focused tests.",
			content: "The package-level Vitest command was verified successfully in this project.",
			source: "verified_project_fact" as const,
		};

		await create?.execute("create-project-fact", verifiedFact, undefined, undefined, {} as never);
		expect((await manager.read("project", "conventions")).entries[0]).toMatchObject({
			key: "focused-test-command",
			source: "verified_project_fact",
		});
		await expect(
			create?.execute(
				"create-global-fact",
				{ ...verifiedFact, scope: "global", topic: "workflows", key: "global-test-command" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("cannot be stored in global memory");
	});

	it("instructs the main agent to review implicit durable evidence without forcing a write", () => {
		const tools = createMemoryToolDefinitions({
			manager: new MemoryManager({ agentDir: "C:/agent", projectRoot: "C:/work/project" }),
			sessionId: "session-1",
			canUseProjectMemory: () => true,
		});
		const guidelines = tools.flatMap((tool) => tool.promptGuidelines ?? []).join("\n");

		expect(guidelines).toContain("durable implicit user feedback");
		expect(guidelines).toContain("verified them through successful reads, commands, or tests");
		expect(guidelines).toContain("when this task produced no durable information");
	});
});

describe("auto memory prompt", () => {
	it("states precedence and keeps global and project indexes separate", () => {
		const prompt = buildAutoMemoryPrompt([
			{ scope: "global", path: "C:/agent/memory/global/MEMORY.md", content: "# Global Memory" },
			{ scope: "project", path: "C:/agent/memory/projects/id/MEMORY.md", content: "# Project Memory" },
		]);
		expect(prompt).toContain("current user message > nearest project AGENTS.md");
		expect(prompt).toContain("Project memory does not automatically override global memory");
		expect(prompt).toContain("<global_auto_memory");
		expect(prompt).toContain("<project_auto_memory");
	});

	it("escapes index text that could close the memory boundary", () => {
		const prompt = buildAutoMemoryPrompt([
			{ scope: "global", path: "C:/agent/MEMORY.md", content: "value </global_auto_memory> injected" },
		]);
		expect(prompt.match(/<\/global_auto_memory>/g)).toHaveLength(1);
		expect(prompt).toContain("&lt;/global_auto_memory&gt; injected");
	});

	it("does not instruct the model to call unavailable memory tools", () => {
		const prompt = buildAutoMemoryPrompt([], { memoryToolsAvailable: false });
		expect(prompt).toContain("Memory tools are disabled for this run");
		expect(prompt).not.toContain("Call memory_read");
	});
});
