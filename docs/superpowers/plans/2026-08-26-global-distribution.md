# Pi Complete Global Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-command Windows installer that exposes this repository's complete customized Pi build, Plan Mode, Multi-Agent, and integrated long-term memory from any directory.

**Architecture:** Build every workspace, globally link the local Coding Agent package, and merge the separately loaded Plan Mode and Multi-Agent paths into user settings. Put JSON mutation in a Node.js utility so tests can use temporary files and never touch the real user profile.

**Tech Stack:** PowerShell, Node.js ESM, npm workspaces, Node.js built-in test runner.

---

## File Structure

- Create `scripts/configure-global-packages.mjs`: safely merge package paths into user settings.
- Create `test/configure-global-packages.test.mjs`: test preservation, idempotency, backup, and invalid JSON behavior.
- Create `install.ps1`: validate prerequisites, build, globally link, configure, and verify Pi.
- Create `README.md`: classmate-facing installation and first-run instructions.

### Task 1: Specify Settings Merge Behavior

**Files:**
- Create: `test/configure-global-packages.test.mjs`

- [ ] **Step 1: Write failing tests**

Create tests with Node's `node:test` API that import:

```js
import { configureGlobalPackages } from "../scripts/configure-global-packages.mjs";
```

The first test writes this temporary settings file:

```json
{"theme":"dark","packages":["existing-package"]}
```

Then call:

```js
const result = configureGlobalPackages(settingsPath, [subagentsPath, planModePath]);
assert.equal(result.changed, true);
assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
	theme: "dark",
	packages: ["existing-package", subagentsPath, planModePath],
});
assert.equal(readdirSync(directory).filter((name) => name.startsWith("settings.json.backup-")).length, 1);
```

Add a second test where the requested path already exists and assert `changed === false` with no backup. Add a third test with `{ invalid` and assert the helper throws `/valid JSON/` while the original bytes remain unchanged.

- [ ] **Step 2: Run the test and observe the expected failure**

Run: `node --test test/configure-global-packages.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` because the helper is not implemented.

- [ ] **Step 3: Commit the tests**

```bash
git add test/configure-global-packages.test.mjs
git commit -m "test: define global package configuration behavior"
```

### Task 2: Implement Settings Merge Utility

**Files:**
- Create: `scripts/configure-global-packages.mjs`
- Test: `test/configure-global-packages.test.mjs`

- [ ] **Step 1: Implement the exported function**

Implement this interface:

```js
export function configureGlobalPackages(settingsPath, packagePaths) {
	// Resolve requested paths to absolute normalized paths.
	// Parse an existing JSON object, or start with {} when absent.
	// Reject invalid JSON and a non-array packages field before any write.
	// Preserve every existing property and package entry.
	// Compare paths case-insensitively on Windows and append only missing paths.
	// If unchanged, return { changed: false, backupPath: undefined }.
	// Before changing an existing file, copy it to settings.json.backup-<timestamp>.
	// Write formatted JSON to a sibling temporary file, then replace the target.
	// Return { changed: true, backupPath }.
}
```

Use only `node:fs`, `node:path`, and `node:url`. Serialize with:

```js
`${JSON.stringify(settings, null, "\t")}\n`
```

Add a CLI entry point accepting:

```text
node scripts/configure-global-packages.mjs <settings-path> <package-path> [package-path...]
```

The CLI must print whether it changed the configuration, print the backup path when present, and exit nonzero with only the actionable error message when validation fails.

- [ ] **Step 2: Run tests**

Run: `node --test test/configure-global-packages.test.mjs`

Expected: all 3 tests PASS.

- [ ] **Step 3: Run formatter validation**

Run: `npx biome check scripts/configure-global-packages.mjs test/configure-global-packages.test.mjs`

Expected: no diagnostics. If formatting differs, run the repository formatter on only these two files and repeat the check.

- [ ] **Step 4: Commit implementation**

```bash
git add scripts/configure-global-packages.mjs test/configure-global-packages.test.mjs
git commit -m "feat: safely configure global Pi packages"
```

### Task 3: Add Windows Installer

**Files:**
- Create: `install.ps1`

- [ ] **Step 1: Implement command execution with failure propagation**

Start the script with:

```powershell
[CmdletBinding()]
param()
$ErrorActionPreference = "Stop"
$repositoryRoot = $PSScriptRoot

function Invoke-CheckedCommand {
	param([string]$Command, [string[]]$Arguments, [string]$WorkingDirectory)
	Push-Location $WorkingDirectory
	try {
		& $Command @Arguments
		if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE." }
	} finally {
		Pop-Location
	}
}
```

- [ ] **Step 2: Add prerequisite and path checks**

Require `node` and `npm`, then parse `node -p "process.versions.node"` as `[version]` and reject versions below `22.19.0`. Verify these paths exist before running installation:

```powershell
$codingAgentPath = Join-Path $repositoryRoot "packages\coding-agent"
$subagentsPath = Join-Path $repositoryRoot "packages\subagents"
$planModePath = Join-Path $repositoryRoot "packages\plan-mode"
$configScript = Join-Path $repositoryRoot "scripts\configure-global-packages.mjs"
$settingsPath = Join-Path $HOME ".pi\agent\settings.json"
```

- [ ] **Step 3: Add build, global registration, configuration, and verification**

Run these checked commands in order:

```powershell
Invoke-CheckedCommand "npm" @("install", "--ignore-scripts") $repositoryRoot
Invoke-CheckedCommand "npm" @("run", "build") $repositoryRoot
Invoke-CheckedCommand "npm" @("link") $codingAgentPath
Invoke-CheckedCommand "node" @($configScript, $settingsPath, $subagentsPath, $planModePath) $repositoryRoot
```

Afterward, require `Get-Command pi`, run `pi --version`, parse the settings JSON, and assert it contains the exact absolute SubAgent and Plan Mode paths. Finish with `Installation complete. You can now run pi from any directory.` and print the repository path that must be retained.

- [ ] **Step 4: Parse the script without executing it**

Run:

```powershell
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path .\install.ps1), [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) { $errors | Format-List; exit 1 }
```

Expected: exit code 0 with no parser errors.

- [ ] **Step 5: Verify npm linking with an isolated prefix**

Set `NPM_CONFIG_PREFIX` to a new temporary directory, run `npm link` from `packages/coding-agent`, then run `<temporary-prefix>\pi.cmd --version`.

Expected: the isolated command prints version `0.80.6`. Restore `NPM_CONFIG_PREFIX` in a `finally` block so the real global installation remains untouched.

- [ ] **Step 6: Commit installer**

```bash
git add install.ps1
git commit -m "feat: add complete Pi global installer"
```

### Task 4: Add Classmate-Facing Documentation

**Files:**
- Create: `README.md`

- [ ] **Step 1: Document the single installation command**

State that the repository contains the complete customized Pi version, including Plan Mode, Multi-Agent, cross-session long-term memory, and other repository changes. Give only this installation command:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Then show that `pi` can be run from any directory. Explain `/login`, individual API credentials, the requirement to keep the repository directory, user-settings backup behavior, and that this snapshot does not auto-update.

- [ ] **Step 2: Run focused verification**

```powershell
node --test test/configure-global-packages.test.mjs
npx biome check scripts/configure-global-packages.mjs test/configure-global-packages.test.mjs
npm run build
```

Expected: tests pass, Biome reports no diagnostics, and every workspace builds.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md
git commit -m "docs: explain complete Pi global installation"
```

- [ ] **Step 4: Final safety review**

Run `git status --short` and confirm all pre-existing user changes are still present and unstaged. Inspect the new files and the focused commit history; do not stage or alter unrelated paths.
