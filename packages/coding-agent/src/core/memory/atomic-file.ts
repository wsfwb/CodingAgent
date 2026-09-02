import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export class AtomicFileConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AtomicFileConflictError";
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (isMissingPathError(error)) return false;
		throw error;
	}
}

async function writeTemporaryFile(path: string, content: string, mode?: number): Promise<void> {
	const handle = await open(path, "wx", mode);
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function assertRegularNonSymlink(path: string): Promise<void> {
	const metadata = await lstat(path);
	if (metadata.isSymbolicLink() || !metadata.isFile()) {
		throw new AtomicFileConflictError(`refusing to replace non-regular file: ${path}`);
	}
}

async function atomicReplaceExistingFile(path: string, content: string): Promise<void> {
	await assertRegularNonSymlink(path);
	const mode = (await stat(path)).mode;
	const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	let temporaryExists = false;
	try {
		await writeTemporaryFile(temporaryPath, content, mode);
		temporaryExists = true;
		await assertRegularNonSymlink(path);
		await rename(temporaryPath, path);
		temporaryExists = false;
	} finally {
		if (temporaryExists) await unlink(temporaryPath).catch(() => {});
	}
}

async function atomicCreateNewFile(path: string, content: string): Promise<void> {
	const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	let temporaryExists = false;
	try {
		await writeTemporaryFile(temporaryPath, content);
		temporaryExists = true;
		try {
			await link(temporaryPath, path);
		} catch (error) {
			if (isAlreadyExistsError(error)) {
				throw new AtomicFileConflictError(`new file appeared while preparing write: ${path}`);
			}
			throw error;
		}
	} finally {
		if (temporaryExists) await unlink(temporaryPath).catch(() => {});
	}
}

export async function atomicWriteMemoryFile(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	if (!(await pathExists(path))) {
		await atomicCreateNewFile(path, content);
		return;
	}
	await atomicReplaceExistingFile(path, content);
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

function isAlreadyExistsError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
