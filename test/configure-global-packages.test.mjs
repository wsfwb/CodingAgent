import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureGlobalPackages } from "../scripts/configure-global-packages.mjs";

test("preserves settings and appends missing package paths", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-global-config-"));
	try {
		const settingsPath = join(directory, "settings.json");
		const subagentsPath = join(directory, "subagents");
		const planModePath = join(directory, "plan-mode");
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark", packages: ["existing-package"] }), "utf8");

		const result = configureGlobalPackages(settingsPath, [subagentsPath, planModePath]);
		const settings = JSON.parse(readFileSync(settingsPath, "utf8"));

		assert.equal(result.changed, true);
		assert.equal(settings.theme, "dark");
		assert.deepEqual(settings.packages, ["existing-package", subagentsPath, planModePath]);
		assert.equal(readdirSync(directory).filter((name) => name.startsWith("settings.json.backup-")).length, 1);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("does not rewrite settings when all package paths already exist", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-global-config-"));
	try {
		const settingsPath = join(directory, "settings.json");
		const packagePath = join(directory, "subagents");
		writeFileSync(settingsPath, JSON.stringify({ packages: [packagePath] }), "utf8");

		const result = configureGlobalPackages(settingsPath, [packagePath]);

		assert.equal(result.changed, false);
		assert.equal(readdirSync(directory).filter((name) => name.startsWith("settings.json.backup-")).length, 0);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
