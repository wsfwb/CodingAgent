# GitHub Complete Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the current complete customized Pi version to the private GitHub repository's default `main` branch with a concise classmate-facing README.

**Architecture:** Keep the existing feature history on `codex/plan-mode`, commit the remaining cancellation feature and documentation there, then fast-forward `main` to the exact same verified commit. Push both branches without force so the remote default branch becomes immediately usable.

**Tech Stack:** Markdown, TypeScript, Vitest, npm workspaces, Git, GitHub CLI.

---

### Task 1: Write the Concise README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace README with the approved content**

Use this structure and no implementation details:

```markdown
# Customized Pi

这是一个基于 Pi 修改和扩展的终端 Coding Agent，保留原有多模型、工具调用和会话能力，并增加了更适合个人开发流程的功能。

## 主要功能

- **Plan Mode**：修改代码前先进行只读分析、澄清需求并生成可确认的实施计划。
- **Multi-Agent**：主 Agent 可以委派独立 SubAgent 进行搜索、分析、修改和复查，并支持后台并发与主动停止。
- **跨会话长期记忆**：按主题保存重要偏好、项目知识和经验，并在后续会话中按需召回。

## Windows 安装

安装 Node.js 22.19.0 或更高版本，然后在仓库根目录运行：

\`\`\`powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
\`\`\`

安装完成后，可以在电脑任意目录运行：

\`\`\`cmd
pi
\`\`\`

首次使用时，在 Pi 中通过 `/login` 配置自己的模型认证。

安装后请保留仓库目录，不要移动或删除，因为全局命令和扩展配置会引用这里的代码。

本仓库不包含 API Key、OAuth 凭证、会话记录或作者的个人长期记忆内容。
```

- [ ] **Step 2: Check Markdown and diff**

Run: `git diff --check -- README.md`

Expected: exit code 0 and no whitespace errors.

### Task 2: Verify and Commit Remaining Complete-Version Changes

**Files:**
- Modify: `packages/coding-agent/src/core/slash-commands.ts`
- Modify: `packages/subagents/examples/agent-tool-description.md`
- Modify: `packages/subagents/src/agent-runner.ts`
- Modify: `packages/subagents/src/index.ts`
- Modify: `packages/subagents/test/agent-runner.test.ts`
- Create: `packages/subagents/test/stop-subagent-wiring.test.ts`
- Create: `Multi-Agent实现笔记.md`
- Create: `Plan Mode实现笔记-整理版.md`
- Modify: `README.md`

- [ ] **Step 1: Run focused SubAgent tests**

Run from `packages/subagents`:

```powershell
node ../../node_modules/vitest/dist/cli.js --run test/agent-runner.test.ts test/stop-subagent-wiring.test.ts
```

Expected: both test files pass with zero failed tests.

- [ ] **Step 2: Run global configuration tests**

Run: `node --test test/configure-global-packages.test.mjs`

Expected: 2 tests pass.

- [ ] **Step 3: Run the complete offline build**

Run: `npm run build:offline`

Expected: TUI, AI, Agent, Coding Agent, SubAgents, Plan Mode, and Orchestrator all compile successfully.

- [ ] **Step 4: Scan the publication set for credentials**

Search the exact publication paths for API-key, bearer-token, and OAuth-token patterns. Expected: no matches. Do not inspect or stage `~/.pi/agent/`.

- [ ] **Step 5: Commit only the approved publication paths**

```bash
git add README.md packages/coding-agent/src/core/slash-commands.ts packages/subagents/examples/agent-tool-description.md packages/subagents/src/agent-runner.ts packages/subagents/src/index.ts packages/subagents/test/agent-runner.test.ts packages/subagents/test/stop-subagent-wiring.test.ts Multi-Agent实现笔记.md "Plan Mode实现笔记-整理版.md"
git commit -m "完善定制版 Pi 发布内容"
```

Leave `初步使用文档.md` untracked.

### Task 3: Push the Feature Branch and Fast-Forward Main

**Files:**
- No file changes.

- [ ] **Step 1: Verify the committed tree and expected leftover**

Run: `git status --short`

Expected: only `初步使用文档.md` remains untracked.

- [ ] **Step 2: Push the complete feature branch**

Run: `git push origin codex/plan-mode`

Expected: remote `origin/codex/plan-mode` advances to the release commit without force.

- [ ] **Step 3: Fast-forward local main**

```bash
git checkout main
git merge --ff-only codex/plan-mode
```

Expected: `main` advances without a merge commit. The untracked `初步使用文档.md` remains untouched.

- [ ] **Step 4: Push the default branch**

Run: `git push origin main`

Expected: remote `main` advances from the initial commit to the same release commit.

- [ ] **Step 5: Verify GitHub state**

Run:

```powershell
gh repo view wsfwb/CodingAgent --json defaultBranchRef,url
git ls-remote origin refs/heads/main refs/heads/codex/plan-mode
```

Expected: default branch remains `main`; both remote refs resolve to the same release commit.
