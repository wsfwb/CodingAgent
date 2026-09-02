import { existsSync, lstatSync, readFileSync } from "node:fs";

/** Return whether a user-controlled resource name is unsafe for a path segment. */
export function isUnsafeName(name: string): boolean {
  if (!name || name.length > 128) return true;
  return !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

/** Return whether a path exists and is a symbolic link. */
export function isSymlink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Read a regular file without following a final-component symbolic link. */
export function safeReadFile(filePath: string): string | undefined {
  if (!existsSync(filePath) || isSymlink(filePath)) return undefined;
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
}
