import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizePlanModeSettings, readPlanModeSettings } from "../src/settings.ts";

test("Plan-mode settings validate inherit and fixed thinking levels", async () => {
	assert.deepEqual(normalizePlanModeSettings({}), { thinkingLevel: "inherit" });
	assert.deepEqual(normalizePlanModeSettings({ thinkingLevel: "medium" }), {
		thinkingLevel: "medium",
	});
	assert.deepEqual(normalizePlanModeSettings({ thinkingLevel: "max" }), {
		thinkingLevel: "max",
	});
	assert.equal(normalizePlanModeSettings({ thinkingLevel: "extreme" }), undefined);

	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-test-"));
	try {
		const path = join(directory, "pi-plan-mode.json");
		await writeFile(path, '{"thinkingLevel":"high"}');
		assert.deepEqual(await readPlanModeSettings(path), {
			kind: "loaded",
			settings: { thinkingLevel: "high" },
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Plan-mode settings migrate to the canonical package filename", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-migration-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		await writeFile(join(directory, "plan-mode.json"), '{"thinkingLevel":"high","futureOption":true}');
		const loaded = await readPlanModeSettings();
		assert.equal(loaded.kind, "loaded");
		assert.match(loaded.notice ?? "", /migrated/i);
		assert.deepEqual(JSON.parse(await readFile(join(directory, "pi-plan-mode.json"), "utf8")), {
			thinkingLevel: "high",
			futureOption: true,
		});
		await assert.rejects(access(join(directory, "plan-mode.json")));

		await writeFile(join(directory, "plan-mode.json"), '{"thinkingLevel":"low"}');
		await writeFile(join(directory, "pi-plan-mode.json"), '{"thinkingLevel":"medium"}');
		const preferred = await readPlanModeSettings();
		assert.deepEqual(preferred.kind === "loaded" ? preferred.settings : undefined, {
			thinkingLevel: "medium",
		});
		assert.match(preferred.notice ?? "", /ignored/i);

		await writeFile(join(directory, "pi-plan-mode.json"), "invalid");
		const invalid = await readPlanModeSettings();
		assert.equal(invalid.kind, "invalid");
		assert.equal(await readFile(join(directory, "plan-mode.json"), "utf8"), '{"thinkingLevel":"low"}');

		await unlink(join(directory, "pi-plan-mode.json"));
		await writeFile(join(directory, "plan-mode.json"), "invalid");
		assert.equal((await readPlanModeSettings()).kind, "invalid");
		await assert.rejects(access(join(directory, "pi-plan-mode.json")));

		await writeFile(join(directory, "plan-mode.json"), '{"thinkingLevel":"high"}');
		try {
			await symlink("missing-target", join(directory, "pi-plan-mode.json"));
		} catch (error) {
			if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return;
			throw error;
		}
		const fallback = await readPlanModeSettings();
		assert.deepEqual(fallback.kind === "loaded" ? fallback.settings : undefined, {
			thinkingLevel: "high",
		});
		assert.match(fallback.notice ?? "", /migration failed/i);
		assert.equal(await readFile(join(directory, "plan-mode.json"), "utf8"), '{"thinkingLevel":"high"}');
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});
