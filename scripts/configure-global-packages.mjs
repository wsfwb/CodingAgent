import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function createBackupPath(settingsPath) {
	const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
	return `${settingsPath}.backup-${timestamp}`;
}

function canonicalPath(value) {
	const resolved = normalize(resolve(value));
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function configureGlobalPackages(settingsPath, packagePaths) {
	const absoluteSettingsPath = resolve(settingsPath);
	const settings = existsSync(absoluteSettingsPath) ? JSON.parse(readFileSync(absoluteSettingsPath, "utf8")) : {};
	const packages = settings.packages ?? [];
	const knownPaths = new Set(packages.filter((value) => typeof value === "string").map(canonicalPath));
	const missingPaths = packagePaths
		.map((packagePath) => normalize(resolve(packagePath)))
		.filter((packagePath) => !knownPaths.has(canonicalPath(packagePath)));
	if (missingPaths.length === 0) return { changed: false, backupPath: undefined };
	settings.packages = [...packages, ...missingPaths];

	mkdirSync(dirname(absoluteSettingsPath), { recursive: true });
	let backupPath;
	if (existsSync(absoluteSettingsPath)) {
		backupPath = createBackupPath(absoluteSettingsPath);
		copyFileSync(absoluteSettingsPath, backupPath);
	}

	const temporaryPath = `${absoluteSettingsPath}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(settings, null, "\t")}\n`, "utf8");
	renameSync(temporaryPath, absoluteSettingsPath);
	return { changed: true, backupPath };
}

function main(args) {
	if (args.length < 2) {
		throw new Error("Usage: node configure-global-packages.mjs <settings-path> <package-path> [package-path...]");
	}

	const result = configureGlobalPackages(args[0], args.slice(1));
	console.log(result.changed ? "Updated global Pi package configuration." : "Global Pi package configuration is already current.");
	if (result.backupPath) console.log(`Backup: ${result.backupPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
