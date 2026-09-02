# 🧭 pi-plan-mode — Codex-like Plan Mode for Pi

[![npm](https://img.shields.io/npm/v/@earendil-works/pi-plan-mode)](https://www.npmjs.com/package/@earendil-works/pi-plan-mode) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

This project-local package is maintained in this repository and is loaded through .pi/settings.json.

Local integration additionally blocks the Multi-Agent tools `Agent`,
`get_subagent_result`, and `steer_subagent` while Plan Mode is active. This prevents
the main session from delegating work that could mutate the repository before the
plan is approved.

`@earendil-works/pi-plan-mode` adds a Codex-like `/plan` collaboration mode to Pi. Plan mode is for read-only exploration, clarifying questions, and a structured implementation-ready plan before any code mutation happens.

Pi core intentionally does not ship a built-in plan mode; this package provides one as an independently installable extension.

## ✨ Features

- Adds `/plan` to enter or manage Plan mode.
- Adds `--plan` to start a session in Plan mode.
- Activates a fixed planning tool set: `read`, `bash`, `grep`, `find`, `ls`, optional `memory_read`, and the two Plan-mode control tools.
- Blocks every tool outside that fixed set, including `edit`, `write`, Multi-Agent tools, memory mutation tools, and `update_plan`.
- Keeps `bash` for exploration and constrains it to read-only use through the Plan-mode system prompt.
- Injects Codex-like Plan mode instructions: explore first, ask decision questions for high-impact ambiguity, do not mutate files, and finalize only when decision-complete.
- Adds required `plan_mode_question` and `plan_mode_complete` tools for structured questions and completion.
- Presents the complete plan with three actions: `执行计划`, `继续规划`, or `放弃计划`.
- Keeps legacy `<proposed_plan>` responses compatible without advertising XML as the primary workflow.
- Shows Plan mode state in Pi's statusline as `plan active` or `plan ready`; `pi-statusline` adds the default `📝` icon unless configured otherwise.
- Persists Plan mode state in the Pi session so resume restores the mode.

## 📦 Install

This release requires Pi 0.80.6 or newer.

```bash
pi install npm:@earendil-works/pi-plan-mode
```

Try without installing permanently:

```bash
pi -e npm:@earendil-works/pi-plan-mode
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-plan-mode
```

## 🚀 Usage

```text
/plan
/plan <prompt>
/plan show
/plan finalize
/plan implement
/plan exit
```

Use `/plan` to enter Plan mode before writing your planning prompt. Use `/plan <prompt>` to enter Plan mode and immediately submit `<prompt>` as the first Plan-mode user message. `/plan show` displays the stored plan without starting a model turn, `/plan finalize` explicitly asks the agent to complete the plan or ask one remaining material question, and `/plan implement` hands a stored plan to a normal implementation turn. `show` and `implement` fail closed when no plan is stored; `finalize` requires active Plan mode.

When Plan mode is active, ask the agent to design the change. The agent may inspect files and run read-only commands, but it should not edit files or execute the implementation. It should explore first, then use structured questions when your preference or a tradeoff materially changes the plan.

Plan mode uses a fixed set of tools. It activates `read`, `bash`, `grep`, `find`, and `ls` when those tools are available. It also activates the project's `memory_read` tool when the long-term-memory extension is loaded, plus the required `plan_mode_question` and `plan_mode_complete` tools. Every other tool is blocked by name even if another extension attempts to reactivate it while Plan mode is running.

When the SubAgent extension is loaded, Plan mode and SubAgent execution are mutually exclusive in the current Pi process. Entering Plan mode is refused while any SubAgent is running or queued. After Plan mode acquires the gate, new SubAgent spawns and resumes are refused until Plan mode exits. A restored Plan-mode session also fails closed when the manager is already busy. This coordination is process-local; a separate Pi process is outside this gate.

`bash` is intentionally not parsed or allowlisted. The injected Plan-mode system prompt tells the model to use Bash only for commands that inspect files, repository state, and configuration without side effects. It explicitly forbids redirects, file changes, Git mutation, dependency installation, formatting, and service startup. This matches the read-only SubAgent design, but it is a model-level behavior constraint, not an OS sandbox or a security boundary. Use Plan mode only in repositories and environments you trust.

`plan_mode_question` follows Codex's `request_user_input` pattern: the agent can ask 1-3 concise questions, each with meaningful options and a free-form Other path. If you cancel or no interactive UI is available, the agent should ask a concise plain-text question or proceed only with a clearly stated low-risk assumption instead of prematurely producing a final plan.

A complete Plan mode answer should appear only after the agent has resolved discoverable facts and high-impact user decisions. The agent must call `plan_mode_complete({ plan })` alone as its final action, passing the complete Markdown plan. The tool rejects empty or whitespace-only plans and plans longer than 50,000 JavaScript characters; it does not truncate. Its visible result contains the full plan, and versioned result details let the extension restore it safely from the active session branch.

`plan_mode_complete` uses Pi's `terminate: true` hint. Termination is best effort: if a model puts it in a parallel tool batch, Pi terminates the batch early only when every finalized sibling tool also terminates. The prompt therefore requires the completion call to be standalone and last. The extension deliberately does not infer completion from phrases such as “I will present the plan,” and it does not automatically retry a turn with no plan because research and clarification turns may legitimately remain unfinished. If a turn ends without a plan, Plan mode stays active; use `/plan finalize` for explicit recovery.

Legacy sessions and models may still submit one non-empty `<proposed_plan>` block with tags on their own lines. That compatibility path remains accepted, but it is not the primary workflow. Empty, malformed, unclosed, or multiple legacy blocks keep Plan mode active and produce a warning.

After completion, `/plan` opens the ready actions when interactive UI is available. Choosing implementation—or running `/plan implement`—disables Plan mode, restores full tool access, and starts an implementation turn with the stored plan. Choosing Stay keeps the plan ready. Revision feedback starts another Plan-mode turn and clears the previous implementable plan until an updated completion arrives. For clarification-only follow-ups, the agent answers and resubmits the complete unchanged plan so it remains implementable. Exit/off discards the plan and removes its completion result from later non-Plan model context. Without interactive UI, the plan remains visible in the tool result and stored as `plan ready`; use `/plan show`, `/plan implement`, or `/plan exit` directly.

While Plan mode is enabled, the extension also publishes a compact status for Pi statuslines. With `pi-statusline`, this appears in the extension status area:

- `plan active`: Plan mode is enabled and still gathering context or drafting a plan.
- `plan ready`: A completed plan is stored until you implement it, continue planning, or exit Plan mode.

You can also exit directly. Direct exit discards the latest proposed plan instead of treating it as an implementation request:

```text
/plan exit
```

## ⚙️ Settings

Create `$PI_CODING_AGENT_DIR/pi-plan-mode.json` (normally `~/.pi/agent/pi-plan-mode.json`) to configure the Plan-mode thinking level globally. The file is optional, is read at session start, and is never created automatically.

```json
{
  "thinkingLevel": "inherit"
}
```

### Thinking level

Plan mode inherits Pi's current thinking level by default. Set `thinkingLevel` to request a fixed level only while Plan mode is active. Supported values are `inherit`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. The extension snapshots the prior level and restores it on exit only if the level still matches the value it applied; a manual change made during Plan mode is preserved. The setting never changes Pi's default thinking level.

Invalid settings produce a warning and fall back to inherited thinking. Compatibility: a valid legacy `plan-mode.json` is migrated automatically to `pi-plan-mode.json`. If both files exist, the new filename takes precedence.

## 🧠 Codex-like behavior

This extension maps Codex's `ModeKind::Plan` behavior onto Pi's extension API:

- Plan mode is a conversational collaboration mode, not TODO/progress tracking.
- `/plan <prompt>` follows Codex behavior by switching to Plan mode before submitting the inline prompt.
- The agent should use `plan_mode_question` for important non-discoverable preferences or tradeoffs before finalizing.
- The agent completes with a standalone `plan_mode_complete` tool call instead of relying on semantic prose detection.
- `update_plan` checklist use is blocked while Plan mode is active.
- The implementation boundary is explicit: Plan mode restores tools before starting implementation, choosing implementation immediately triggers a normal agent turn with full tool access, and plain exit/off discards the stored plan.
- Plan mode enforces a fixed tool-name boundary, while Bash read-only behavior relies on the injected system prompt.
- Unlike native Codex, this extension uses a terminating Pi tool plus an `agent_settled` ready flow and does not provide sandbox-level Bash enforcement.

## 🗂️ Package layout

```txt
extensions/pi-plan-mode/
├── src/
│   ├── plan-mode.ts  # Pi entrypoint and mode state
│   └── *.ts          # Package-local prompt, policy, question, and message modules
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

Only `plan-mode.ts` is a Pi entrypoint; the other source modules are internal. The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/plan-mode.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, plan mode, Codex-like plan mode, AI coding workflow, read-only planning, implementation plan.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
