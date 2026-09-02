import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";

export class MemoryLockError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MemoryLockError";
	}
}

export async function acquireMemoryScopeLock(scopeDirectory: string): Promise<() => Promise<void>> {
	await mkdir(scopeDirectory, { recursive: true });
	try {
		const release = await lockfile.lock(scopeDirectory, {
			realpath: false,
			lockfilePath: join(scopeDirectory, "write-memory.lock"),
			stale: 30_000,
			update: 10_000,
			retries: { retries: 20, factor: 1, minTimeout: 50, maxTimeout: 250 },
		});
		let released = false;
		return async () => {
			if (released) return;
			released = true;
			await release();
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new MemoryLockError(`could not acquire memory write lock: ${message}`);
	}
}
