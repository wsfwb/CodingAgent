# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project overview

Pi is a coding agent CLI and runtime. This is an npm workspace monorepo with five packages, all under `@earendil-works` scope and versioned in lockstep.

| Package | Purpose |
|---------|---------|
| `packages/ai` | Unified multi-provider LLM API — provider model catalogs + API implementations |
| `packages/agent` | Agent runtime — core agent loop, compaction, session storage, skills, system prompts |
| `packages/coding-agent` | CLI entry point — interactive TUI, print mode, RPC mode, tools, extensions, settings |
| `packages/tui` | Terminal UI library — differential rendering, text editor component, keybindings |
| `packages/orchestrator` | Experimental multi-agent supervisor (spawns coding-agent RPC children) |

Dependency chain: `tui` ← `ai` ← `agent` ← `coding-agent` ← `orchestrator`

## Common commands

```bash
npm install --ignore-scripts     # Install all workspace deps
npm run build                    # Build all packages (order: tui → ai → agent → coding-agent → orchestrator)
npm run check                    # Full CI check: biome lint/format + pinned deps + TS imports + shrinkwrap + typecheck
./test.sh                        # Run all tests with API keys unset (skips LLM-dependent tests)
./pi-test.sh [--no-env] [args]   # Run pi from sources via tsx

# Run a single package's tests from its directory:
node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts

# Run specific vitest file with filtering:
npx vitest --run test/some.test.ts -t "test name pattern"
```

TypeScript is compiled with `tsgo` (native TS compiler, `@typescript/native-preview`). Only erasable TypeScript syntax is allowed — no enums, namespaces, parameter properties, or `import =` / `export =`.

## Architecture

### AI package (`packages/ai`)

**Provider pattern**: each provider has two files:
- `providers/<name>.models.ts` — model catalog (static list of known models with capabilities)
- `api/<name>.ts` — API implementation (maps Pi's internal request types to provider-specific wire format)

`models.generated.ts` and `image-models.generated.ts` are auto-generated from provider model lists. Never edit them directly; update `scripts/generate-models.ts` and regenerate.

Providers with lazy-loaded APIs (Anthropic, Google, Mistral, etc.) have a companion `.lazy.ts` file that wraps the API behind a dynamic import so SDKs aren't loaded until the provider is actually used.

`types.ts` defines the core abstractions: `LlmProvider`, `LlmRequest`, `LlmResponse`, `LlmStreamEvent`, tool definitions, content blocks, etc.

### Agent package (`packages/agent`)

The core loop lives in `agent-loop.ts` — it manages turn-by-turn conversation, tool call execution, and response streaming.

`agent.ts` provides the high-level `Agent` class that owns the loop, session storage (JSONL-based), and compaction.

Compaction (`harness/compaction/compaction.ts`): when context exceeds the model's window, older turns are summarized and replaced with a synthetic compaction message. Branch summarization (`harness/compaction/branch-summarization.ts`) handles tree-structured sessions where branches share a common prefix.

Session storage: `harness/session/` — JSONL repos for sessions with `jsonl-repo.ts` as the storage layer and `session.ts` as the domain model.

Skills (`harness/skills.ts`): skill definitions with frontmatter, loaded from directories, exposed to the agent as system-prompt content.

### Coding agent package (`packages/coding-agent`)

**Entry points**: `src/cli.ts` parses args via `cli/args.ts` and dispatches to one of three modes:
- `modes/interactive/interactive-mode.ts` — full TUI with the pi terminal UI
- `modes/print-mode.ts` — non-interactive `-p` flag
- `modes/rpc/` — JSON-RPC over stdio for orchestrator/supervisor

**Core modules** (in `src/core/`):
- `session-manager.ts` — session lifecycle, tree-structured conversations, entry serialization
- `agent-session.ts` — the per-session agent runtime, wraps the agent-core loop with coding-agent tools
- `settings-manager.ts` — layered config (defaults → user → workspace → local)
- `model-registry.ts` — loads provider models, resolves aliases, manages auth status
- `model-resolver.ts` — resolves CLI model specifiers (e.g. `sonnet`, `opus`, `Codex-opus-4-8`) to concrete provider models with auth
- `package-manager.ts` — extension and resource installation (npm-based)
- `resource-loader.ts` — loads AGENTS.md, AGENTS.md, .gitignore, and other project context files
- `extensions/` — extension system (loader, runner, hook types). Extensions can hook into tool calls, agent lifecycle, and UI
- `tools/` — built-in tools: bash, read, write, edit, grep, find, ls (each tool has a definition factory and an operations interface)
- `compaction/` — context window management shared with agent-core

**Auth**: `auth-storage.ts` is the credential persistence layer. Auth flow uses OAuth device-code or API keys depending on the provider. Auth state is stored in `~/.pi/agent/auth.json`.

### TUI package (`packages/tui`)

`tui.ts` (~58K) is the core rendering engine: differential output that computes a diff between desired and actual terminal state, then emits only the changed cells.

`terminal.ts` wraps raw terminal I/O (stdin raw mode, cursor control, SIGWINCH handling).

`keys.ts` (~45K) is a comprehensive key-parsing table mapping terminal escape sequences to named keys.

`autocomplete.ts` (~23K) provides filesystem-aware tab completion.

`components/` contains reusable UI components (select lists, dialogs, etc.) built on the TUI primitives.

### Orchestrator package (`packages/orchestrator`)

Spawns coding-agent instances as child processes communicating via JSON-RPC over stdio (`ipc/`). The `supervisor.ts` manages the child lifecycle. `radius.ts` (~13K) is the main orchestration logic.

## Extension system

Extensions are npm packages that export an `ExtensionFactory` function. They hook into the agent lifecycle via `ExtensionContext` and can:
- Register custom slash commands and tools
- Intercept tool calls (bash, read, write, edit, grep, find, ls)
- Add UI components (widgets, editors, selectors)
- Provide autocomplete providers
- Handle project trust decisions

Extensions are loaded from `~/.pi/extensions/` and workspace `.pi/extensions/`.

## Key design rules

- **No inline imports**: all imports must be top-level (Node strip-only TS mode requirement).
- **Erasable syntax only**: no enums, namespaces, parameter properties, `import =`, `export =`.
- **Never hardcode key checks**: add entries to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` instead of `matchesKey(keyData, "ctrl+x")`.
- **Never edit `packages/ai/src/models.generated.ts` directly**: update `packages/ai/scripts/generate-models.ts` and regenerate.
- **Pin external deps to exact versions**: workspace packages use `^` ranges. `package-lock.json` is ground truth.
- **Pre-commit blocks lockfile commits** unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.

## Session storage format

Sessions are stored as JSONL files in `~/.pi/agent/sessions/`. Each line is a JSON entry with a type field: `header`, `message`, `file`, `compaction`, `model-change`, `custom`, etc. Sessions support tree-structured branching (forks) with parent references.

## Git safety rules

Multiple pi sessions may be running concurrently in the same repo. Never run these destructive commands: `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`. Always stage explicit paths.
