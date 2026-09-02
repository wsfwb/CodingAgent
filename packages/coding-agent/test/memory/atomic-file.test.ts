import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteMemoryFile } from "../../src/core/memory/index.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-memory-atomic-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("atomicWriteMemoryFile", () => {
	it("creates and replaces a file without leaving temporary files", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "MEMORY.md");

		await atomicWriteMemoryFile(path, "first\n");
		await atomicWriteMemoryFile(path, "second\n");

		expect(await readFile(path, "utf8")).toBe("second\n");
		expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("refuses to replace a directory", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "MEMORY.md");
		await mkdir(path);

		await expect(atomicWriteMemoryFile(path, "content\n")).rejects.toThrow("refusing to replace non-regular file");
	});
});
