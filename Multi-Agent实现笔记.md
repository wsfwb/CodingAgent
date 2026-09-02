# 主从式 Multi-Agent 实现笔记

## 1. 功能概述

该功能通过 Pi 的扩展系统实现了一套主从式 Multi-Agent 架构：

- 主 Agent 负责理解用户目标、拆分任务、选择 SubAgent、整合结果并作出最终决策。
- SubAgent 负责完成被委派的局部任务，例如搜索代码、制定方案、修改代码或运行测试。
- 每个 SubAgent 都有独立上下文、系统提示词、模型、工具权限和 `AgentSession`。
- SubAgent 内部运行完整的 Agent Loop，而不是只调用一次 LLM。
- 系统同时支持前台同步执行和后台异步并发执行。
- `AgentManager` 统一管理生命周期、并发队列、中途干预和结果回传。
- 可选的 Git Worktree 隔离允许多个可写 SubAgent 在独立工作区内修改代码。

整体调用关系如下：

```text
用户任务
  -> 主 Agent 判断是否委派
  -> 调用 Agent 工具
  -> Agent 注册表解析 SubAgent 类型
  -> AgentManager 创建记录并负责调度
  -> AgentRunner 创建独立 AgentSession
  -> SubAgent 执行自己的 Agent Loop
  -> 前台直接返回结果 / 后台通过 follow-up 通知结果
  -> 主 Agent 汇总并继续执行
```

这套架构属于 Multi-Agent，也可以称为“主 Agent + SubAgent”架构。它不是多个地位完全对等、自由通信的 Agent 网络，而是由主 Agent 集中编排的层级式系统。

## 2. 内置 SubAgent 类型

系统内置三种 SubAgent：

| 类型 | 主要用途 | 默认工具 |
|---|---|---|
| `general-purpose` | 通用调查、修改代码、运行测试、复杂多步骤任务 | 全部允许的内置工具 |
| `Explore` | 快速定位文件、搜索符号、分析调用关系 | `read`、`find`、`ls`、`grep`、`bash` |
| `Plan` | 调研项目、分析取舍、制定实现方案 | `read`、`find`、`ls`、`grep`、`bash` |

三种内置 Agent 默认都没有固定模型，因此最终会继承主 Agent 当前使用的模型。

`general-purpose` 使用 `promptMode = "append"`：保留主 Agent 的系统提示词，并追加 SubAgent 身份和任务说明。

`Explore` 和 `Plan` 使用 `promptMode = "replace"`：不复制主 Agent 的完整系统提示词，而是使用各自专门设计的只读系统提示词。

三者默认都不继承主会话消息，等价于 `inheritContext = false`。主 Agent 应当在委派 Prompt 中明确提供完成任务所需的信息；确实需要历史对话时，可以显式开启上下文继承。

### 2.1 “只读”能力的边界

`Explore` 和 `Plan` 没有 `write`、`edit` 工具，并且系统提示词明确禁止通过重定向、脚本或命令修改文件。

但它们仍有 `bash`，所以这里的只读是“工具白名单 + 提示词约束”，不是操作系统级只读沙箱。理论上模型仍可能通过有副作用的 Shell 命令修改环境。这是当前设计的安全边界，不能描述为绝对只读。

### 2.2 防止递归创建 SubAgent

即使自定义 SubAgent 加载了扩展工具，系统也会从它的最终工具集合中移除 `Agent` 等 SubAgent 管理工具，避免 SubAgent 继续创建下一层 SubAgent，导致递归失控、成本不可控或调度关系过于复杂。

## 3. AgentConfig：SubAgent 的类型定义

每种 SubAgent 都由 `AgentConfig` 描述。下面保留理解执行流程最重要的字段：

```ts
interface AgentConfig {
  name: string;
  displayName?: string;
  description: string;

  builtinToolNames?: string[];
  disallowedTools?: string[];
  extensions: true | string[] | false;
  skills: true | string[] | false;

  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;

  systemPrompt: string;
  promptMode: "replace" | "append";
  inheritContext?: boolean;
  runInBackground?: boolean;

  persistSession?: boolean;
  outputTranscript?: boolean;
  memory?: "user" | "project" | "local";
  isolation?: "worktree";

  enabled?: boolean;
  source?: "default" | "project" | "global";
}
```

这些字段可以分成五类：

| 类别 | 作用 | 代表字段 |
|---|---|---|
| 身份 | 告诉主 Agent 何时使用它 | `name`、`description` |
| 权限 | 限制可用工具、扩展和 Skill | `builtinToolNames`、`extensions`、`skills` |
| 推理 | 选择模型、思考等级和轮次 | `model`、`thinking`、`maxTurns` |
| 上下文 | 构造系统提示词和会话输入 | `systemPrompt`、`promptMode`、`inheritContext` |
| 执行策略 | 控制后台、持久化、记忆和隔离 | `runInBackground`、`persistSession`、`memory`、`isolation` |

## 4. 自定义 SubAgent 与注册表

用户可以使用 Markdown 文件定义新的 SubAgent 类型。程序通过普通的 Frontmatter 解析器读取固定字段，并将正文作为 `systemPrompt`，不需要调用 LLM 解析配置。

示例：

```md
---
description: 审查认证模块的安全问题
tools: read, grep, find, ls, bash
extensions: none
skills: none
thinking: high
max_turns: 20
prompt_mode: replace
inherit_context: false
run_in_background: true
---

你是安全审查 Agent。重点检查认证、授权、输入校验和敏感信息泄漏。
只报告有代码证据支持的问题。
```

Agent 类型按名称放入统一注册表。同名配置的覆盖优先级为：

```text
<cwd>/.pi/agents/*.md
  > <cwd>/.agents/agents/*.md
  > ~/.pi/agent/agents/*.md
  > 程序内置 Agent
```

因此，项目可以覆盖全局配置，也可以使用同名 Markdown 覆盖内置的 `Explore` 或 `Plan`。

每次调用 `Agent` 工具时都会重新加载注册表，所以修改 Markdown 后不必重启 Pi。若指定类型不存在，系统退回 `general-purpose` 配置。

## 5. 主 Agent 如何调用 SubAgent

`Agent` 与 `read`、`grep` 等工具一样，会把工具名、描述和参数 Schema 放入主模型的 Context。主 Agent LLM 根据当前任务和工具描述决定是否委派；用户也可以在 Prompt 中明确要求使用某种 SubAgent。

典型调用：

```json
{
  "name": "Agent",
  "arguments": {
    "subagent_type": "Explore",
    "prompt": "查找认证模块的入口、核心类型和主要调用链",
    "description": "调查认证模块",
    "run_in_background": true
  }
}
```

这里需要区分两组概念：

- `AgentConfig` 描述一种可复用的 SubAgent 类型。
- `Agent` 工具参数描述这一次具体调用。

`prompt` 是本次任务的 `UserMessage`，不是 `AgentConfig.systemPrompt`；`description` 是本次运行的短说明，也不是类型级的 `AgentConfig.description`。

`resume` 和 `schedule` 属于调用级参数，不属于 `AgentConfig`：

- `resume`：根据 Agent ID 继续一个仍保存在内存中的 SubAgent 会话。
- `schedule`：保存任务定义，到触发时间后再启动后台 SubAgent，而不是立即执行。

配置合并时，当前实现对模型、思考等级、最大轮次和执行策略大体采用“类型配置优先，调用参数其次，最后使用默认值”的方式。因此，自定义 Agent 中固定配置的字段不会被普通调用参数覆盖。

## 6. 核心组件及职责

### 6.1 Agent 工具

它是主 Agent 进入 Multi-Agent 系统的入口，负责：

1. 解析工具参数。
2. 加载并查找 Agent 注册表。
3. 合并 Agent 类型配置与本次调用配置。
4. 选择前台或后台执行路径。
5. 将任务交给 `AgentManager`。

### 6.2 AgentManager

`AgentManager` 负责“管理任务”，不负责具体推理：

- 创建 Agent ID 和 `AgentRecord`。
- 维护后台并发计数和 FIFO 队列。
- 启动、停止、干预和恢复 SubAgent。
- 保存运行状态、Token 用量、结果和错误。
- 在 SubAgent 结束后触发通知和 Worktree 清理。

### 6.3 AgentRunner

`AgentRunner` 负责“创建并运行一个真正的 Agent”：

- 解析模型和思考等级。
- 构造系统提示词。
- 计算最终工具白名单。
- 加载允许的扩展、Skill 和 Memory。
- 创建独立 `AgentSession`。
- 可选地桥接主会话上下文。
- 启动 Agent Loop 并收集最终文本。
- 统计轮次、工具调用、Token 和压缩次数。

### 6.4 AgentSession 与 Agent Loop

每个 SubAgent 拥有独立 `AgentSession` 和消息列表。其内部流程与普通 Coding Agent 类似：

```text
SubAgent UserMessage
  -> 调用模型
  -> 生成 AssistantMessage
  -> 如有工具调用，则执行工具并生成 ToolResultMessage
  -> 将新消息加入自己的 Session
  -> 再次调用模型
  -> 直到模型不再调用工具或运行被终止
```

所以 SubAgent 不是“让模型回答一次问题”，而是具备自主搜索、调用工具、观察结果并继续行动的完整 Agent。

## 7. 一次完整调用的执行流程

### 7.1 公共前半段

无论前台还是后台，都会经过以下步骤：

1. 主 Agent 调用 `Agent` 工具。
2. 工具重新加载 Agent 注册表并取得 `AgentConfig`。
3. 系统解析模型、思考等级、轮次、上下文继承、后台模式和隔离模式。
4. `AgentManager` 立即生成 Agent ID，并在内存 Map 中创建 `AgentRecord`。
5. 如果使用 Worktree，先创建隔离工作区；创建失败则严格报错，不回退主目录。
6. `AgentRunner` 构造系统提示词和工具集合。
7. `AgentRunner` 创建独立 `AgentSession`，再启动 Agent Loop。
8. 运行事件持续更新 `AgentRecord` 中的工具次数、Token、压缩次数、结果和错误。

### 7.2 前台模式

```text
主 Agent 调用 Agent 工具
  -> SubAgent 立即运行，不进入后台队列
  -> 主 Agent 的该次工具调用保持等待
  -> SubAgent 完成、失败或终止
  -> 最终结果作为本次 Agent 工具唯一的 ToolResultMessage 返回
  -> 主 Agent 继续推理
```

前台 Agent 不占后台并发名额。因为结果已经随工具调用直接返回，所以会将 `resultConsumed` 标记为已消费，避免再发送一遍完成通知。

### 7.3 后台模式

```text
主 Agent 调用 Agent 工具
  -> AgentManager 创建 AgentRecord
  -> 有并发名额：status = running
     无并发名额：status = queued
  -> Agent 工具立即返回 Agent ID 和当前状态
  -> 主 Agent 可以继续工作
  -> SubAgent 在后台完成
  -> 系统使用 follow-up 消息通知主 Agent
  -> 主 Agent 进入新一轮推理并处理结果
```

后台任务创建时，第一次 `ToolResultMessage` 已经用于返回 Agent ID 和排队状态。结束后不能再为同一个工具调用生成第二个 `ToolResultMessage`，否则会破坏工具调用与工具结果的一一对应关系，所以后台完成结果使用 follow-up 消息交付。

## 8. AgentRecord：运行时控制面

`AgentRecord` 保存在 `AgentManager` 的内存 Map 中：

```ts
Map<agentId, AgentRecord>
```

可以把它理解为每次 SubAgent 运行的“控制面记录”。关键字段如下：

```ts
interface AgentRecord {
  id: string;
  type: string;
  description: string;
  status: "queued" | "running" | "completed" |
          "steered" | "aborted" | "stopped" | "error";

  session?: AgentSession;
  promise?: Promise<string>;
  abortController?: AbortController;
  result?: string;
  error?: string;

  toolUses: number;
  lifetimeUsage: LifetimeUsage;
  compactionCount: number;
  startedAt: number;
  completedAt?: number;

  pendingSteers?: string[];
  resultConsumed?: boolean;
  groupId?: string;
  joinMode?: "async" | "group" | "smart";

  worktree?: WorktreeInfo;
  worktreeResult?: WorktreeCleanupResult;
  outputFile?: string;
}
```

其中：

- `session` 是 SubAgent 的实际会话。
- `promise` 表示本次异步执行，前台等待和后台查询都会使用。
- `abortController` 用于中断正在运行的会话。
- `pendingSteers` 暂存 Session 创建前收到的追加指令。
- `resultConsumed` 防止已读取的结果再次通过完成通知推送。
- `worktreeResult` 在 Worktree 清理流程全部结束后才赋一次最终值，不经历 `preservation_failed -> saved` 的中间状态变化。

## 9. 后台并发、队列与结果合并

后台 SubAgent 是基于 Promise 和异步 I/O 的并发，不是为每个 Agent 创建一个 CPU 线程或独立操作系统进程。

每个后台 SubAgent 仍有独立的：

- `AgentSession`
- 消息列表
- 工具调用流程
- `AgentRecord`
- 模型请求与 Token 统计

默认最多同时运行 4 个后台 SubAgent：

```ts
private queue: { id: string; args: SpawnArgs }[] = [];
private runningBackground = 0;
private maxConcurrent = 4;
```

调度规则：

1. `runningBackground < maxConcurrent` 时立即运行。
2. 达到上限时进入 FIFO 队列，状态为 `queued`。
3. 任一后台 Agent 结束后，并发计数减一。
4. `AgentManager` 从队首取任务启动，直到再次达到并发上限。

后台结果支持三种合并策略：

| 模式 | 含义 |
|---|---|
| `async` | 每个 Agent 完成后独立通知 |
| `group` | 同组结果等待合并后通知 |
| `smart` | 根据调用场景选择合适的交付方式 |

分组模式下，从第一项完成开始等待 30 秒：

- 30 秒内全部完成：一次发送整组结果。
- 超时后仍有任务运行：先发送已完成结果，剩余任务继续运行。
- 后续落后的任务会再次分批交付，避免一个慢任务无限阻塞整组。

## 10. 中途干预、停止和 Resume

### 10.1 Steering

主 Agent 可以向已有 SubAgent 追加或纠正指令。Steering 消息会作为新的 `UserMessage` 进入 SubAgent 会话。

- Session 已创建：直接调用 `session.steer(message)`。
- Agent 仍在排队或 Session 尚未创建：先写入 `pendingSteers`，Session 创建后依次补发。

### 10.2 Stop

- 对排队中的 Agent：从队列中移除并标记为 `stopped`。
- 对运行中的 Agent：调用 `AbortController.abort()`，中断对应 `AgentSession`。

### 10.3 Resume

示例：

```json
{
  "subagent_type": "Explore",
  "resume": "abc123",
  "prompt": "继续调查调用方，并重点查看异常处理",
  "description": "继续认证调查"
}
```

Resume 的流程是：

1. 根据 Agent ID 查找 `AgentRecord`。
2. 取得原来的 `AgentSession`。
3. 将新 Prompt 加入同一个 Session。
4. 重新启动该 Session 的 Agent Loop。

它是短期、当前进程内的继续能力，不是进程重启后的完整恢复。完成记录大约 10 分钟后会从 Manager 内存清理；Pi 进程重启后也不会从磁盘重建正在运行的 `AgentRecord`。

## 11. 系统提示词与上下文继承

### 11.1 `append` 模式

主要用于 `general-purpose`：

```text
主 Agent 有效系统提示词
+ SubAgent 上下文桥接说明
+ <active_agent> 标签
+ 当前工作目录和 Git 环境
+ 自定义 systemPrompt
+ Memory 和预加载 Skill
```

保留主系统提示词可以让通用 SubAgent 获得与主 Agent 接近的行为规则，同时把公共前缀放在前面也有利于模型 KV Cache 复用。

### 11.2 `replace` 模式

主要用于 `Explore` 和 `Plan`：

```text
<active_agent> 标签
+ SubAgent 基础身份
+ 当前工作目录和 Git 环境
+ 该类型的完整 systemPrompt
+ Memory 和预加载 Skill
```

该模式避免主 Agent 的复杂身份和写入指令干扰专用只读角色。

### 11.3 `inheritContext`

开启后，系统读取主会话当前分支，把以下内容转换成普通文本并拼接到 SubAgent 第一条 UserMessage 前：

- UserMessage 文本
- AssistantMessage 文本
- 已有的压缩摘要

工具结果默认跳过，因为它们通常体积很大。这样做不是“复制整个主 Agent 内存对象”，而是向 SubAgent 提供一份精简的历史文本。

默认关闭的原因是减少 Token 消耗和无关信息干扰，并让委派任务的输入边界更清晰。

## 12. 轮次限制

达到 `maxTurns` 后，系统不会立即粗暴终止，而是先发送 Steering：

```text
You have reached your turn limit. Wrap up immediately and provide your final answer now.
```

随后给予若干宽限轮次（当前默认 5 轮），让 SubAgent 总结已有结果。如果宽限轮次结束后仍未停止，才会中断 Session。

这种“软限制 + 硬上限”兼顾成本控制和结果完整性。

## 13. SubAgent 数据保存

系统中有三种不同层次的数据，不能混为一谈：

| 数据 | 默认位置 | 作用 | 能否恢复运行状态 |
|---|---|---|---|
| `AgentRecord` | 当前 Pi 进程内存 | 调度、状态、结果、统计与控制 | 仅当前进程内 |
| `AgentSession` | 默认内存；可选标准 Session JSONL | 保存会话消息并支持 Agent Loop | 取决于 `persistSession` |
| `.output` Transcript | 磁盘 JSONL | 查看、调试 SubAgent 的消息与工具过程 | 不能重建 Manager 调度状态 |

`persistSession = true` 时，SubAgent 使用 Pi 标准 Session JSONL；否则使用内存 Session。

`outputTranscript` 默认开启，记录 `UserMessage`、`AssistantMessage` 和 `ToolResultMessage`。它是执行日志，不等价于完整崩溃恢复，因为其中没有足够信息重建后台队列、Promise、`AbortController` 和所有运行时回调。

SubAgent 结束后，扩展还会向主 Session 追加摘要记录，供历史展示和其他扩展读取；它同样不是对运行中 Agent 的完整持久化。

## 14. Worktree 隔离

### 14.1 必要的 Git 概念

| 概念 | 含义 |
|---|---|
| 仓库根目录 | 包含 `.git`、项目文件和工作区的顶层目录 |
| `cwd` | 当前工作目录，决定相对路径、Git 命令和工具操作的位置 |
| Commit | 项目某一时刻的版本快照 |
| Commit SHA | Commit 的哈希标识，可理解为版本身份证 |
| Branch | 指向某个 Commit 的可移动指针 |
| HEAD | 当前工作区所处的分支或 Commit |
| Detached HEAD | HEAD 直接指向 Commit，而不是某个分支 |
| Working Tree | 当前可以直接读取和修改的项目文件 |
| Git Worktree | 同一 Git 仓库额外展开的一套独立工作目录 |

多个 Worktree 共享 Git 对象和提交历史，但各自拥有独立的磁盘文件。因此，一个 Worktree 中修改 `auth.ts` 不会直接修改主工作区中的 `auth.ts`。

### 14.2 为什么使用 Detached Worktree

创建命令的核心含义是：

```bash
git worktree add --detach <临时目录> HEAD
```

- `worktree add`：增加工作目录。
- `--detach`：新工作区暂时不绑定现有分支。
- `<临时目录>`：展开文件的位置。
- `HEAD`：从主仓库当前 Commit 开始。

假设主仓库当前版本为 `99c8326`：

```text
主工作区：       HEAD -> codex/plan-mode -> 99c8326
SubAgent Worktree：HEAD -----------------> 99c8326
```

两个目录初始内容相同，之后可以独立修改。SubAgent 完成后再为结果创建新分支，避免多个并行 Agent 一开始就共享同一个分支和工作目录。

### 14.3 baseSha 的作用

创建 Worktree 时记录：

```bash
git rev-parse HEAD
```

得到的 Commit SHA 保存为 `baseSha`，表示 SubAgent 从哪个版本开始工作。

结束时同时检查 Git 工作区状态和当前 HEAD：

- 没有未提交文件，且 `HEAD == baseSha`：没有产生修改。
- 存在未提交文件：需要先保存修改。
- 没有未提交文件，但 `HEAD != baseSha`：SubAgent 已经自行创建 Commit，也需要保留该提交。

### 14.4 Worktree 创建流程

Worktree 不是默认开启的；只有 Agent 类型或本次调用指定 `isolation: "worktree"` 才启用。

完整流程：

1. `AgentManager` 创建 `AgentRecord`。
2. 确认 `cwd` 位于 Git 仓库且存在 HEAD。
3. 使用 `git status --porcelain=v1 --untracked-files=all` 检查主仓库。
4. 只要存在已暂存、未暂存或未跟踪文件，就拒绝创建 Worktree。
5. 记录仓库根目录、原 `cwd` 对应的仓库子目录和 `baseSha`。
6. 在系统临时目录创建 Detached Worktree。
7. 将 SubAgent 的 `cwd` 改为 Worktree 内对应路径。
8. 将路径、分支名、`baseSha` 和工作子目录写入 `AgentRecord.worktree`。
9. 创建 SubAgent 的 `AgentSession` 并开始执行。

拒绝脏工作区的原因是 Worktree 从 `HEAD` 创建，未提交修改不会自动出现在新 Worktree 中。如果继续执行，SubAgent 看到的代码会和用户当前主工作区不一致。

如果不是 Git 仓库、没有首次提交、Git 不可用或 Worktree 创建失败，系统严格报错，不偷偷回退到主工作区。否则用户以为已隔离，实际却可能直接修改主目录。

### 14.5 Worktree 清理三态

清理函数最终只返回以下三种结果之一：

```ts
type WorktreeCleanupResult =
  | { status: "clean" }
  | { status: "saved"; branch: string }
  | { status: "preservation_failed"; path: string; error: string };
```

| 状态 | 含义 | Worktree 处理 |
|---|---|---|
| `clean` | 没有产生修改 | 删除临时 Worktree |
| `saved` | 修改已保存到 Commit 和分支 | 删除临时 Worktree |
| `preservation_failed` | 无法确认或保存修改 | 保留现场 |

清理流程：

```text
SubAgent 结束
  -> cleanupWorktree() 完整执行
     -> Worktree 不存在：preservation_failed
     -> Git 状态干净且 HEAD == baseSha：删除并返回 clean
     -> 有未提交修改：暂存并提交
     -> HEAD 与 baseSha 不同：创建结果分支
     -> 分支创建成功：删除并返回 saved
     -> 任一 Git 操作失败：保留目录并返回 preservation_failed
  -> AgentManager 将最终结果一次性赋给 record.worktreeResult
```

`worktreeResult` 在 SubAgent 执行期间是 `undefined`。它不会先设为 `preservation_failed`，成功后再改为 `saved`；而是等待整个同步清理函数结束，再写入一个最终状态。

若结果为 `saved`，主 Agent 得到分支名，可先审查：

```bash
git show pi-agent-<agentId>
```

确认后再合并：

```bash
git merge pi-agent-<agentId>
```

若结果为 `preservation_failed`，系统将 `AgentRecord.status` 标记为 `error`，保留 Worktree 路径和 Git 错误，避免为了清理临时目录而丢失代码。

## 15. SubAgent Memory

自定义 Agent 可以配置专属 Memory，例如：

```text
.pi/agent-memory/security-reviewer/
├─ MEMORY.md
└─ auth-findings.md
```

启动时，系统读取 `MEMORY.md` 的前 200 行并注入系统提示词。SubAgent 可根据索引决定是否再读取详细主题文件。

记忆写入没有独立的 MemoryManager，而是由具备写权限的 SubAgent 使用 `read`、`write`、`edit` 直接修改 Markdown。只读 Agent 只获得读取记忆所需的能力。

该功能是每种 SubAgent 的角色经验，不应与主 Agent 的跨会话长期记忆系统混为一谈。

## 16. 方案演进与设计取舍

### 16.1 最初设想

最初希望接近 Claude Code、Codex 等复杂编排：

- 多个 SubAgent 并行读写。
- Agent 之间自由通信。
- 使用 Worktree 隔离文件修改。
- 对崩溃和冲突进行完整恢复。

这个方向能力强，但会同时引入任务调度、通信拓扑、代码合并、冲突处理、状态持久化和恢复一致性等问题，复杂度与当前项目体量不匹配。

### 16.2 第一版实现

第一版固定为 `Explorer`、`Reviewer`、`Worker`：

- SubAgent 之间不能直接通信，只能经主 Agent 中转。
- 只读 Agent 并行，Worker 串行写入。
- Worker 记录原文件备份和修改前后哈希。
- 崩溃后根据哈希判断能否恢复原文件。
- 使用带心跳的跨进程 Worker 锁，避免多个 Pi 进程同时写同一项目。

后来否决的主要原因：

1. 本地单用户同时运行多个写 Agent 并崩溃的概率较低。
2. 文件级备份和哈希无法真正解决跨文件原子回滚。
3. 锁、心跳、崩溃恢复和交付状态显著增加实现与解释成本。
4. 原项目普通写工具本身也没有同等级的跨进程事务保证，单独强化 Worker 会造成设计不一致。

### 16.3 当前方案

当前方案改为可配置的主从式 SubAgent 系统：

- 用 Agent 注册表代替固定的三个角色。
- 每个 SubAgent 运行独立完整 Agent Loop。
- 通过前台/后台模式兼顾同步结果与并发效率。
- 通过 `AgentManager` 统一处理调度、状态和干预。
- 默认不为普通执行增加重型恢复机制。
- 确实需要并行写代码时，显式开启 Git Worktree 隔离，并把成果保存为分支。

这个方案利用 Git 已有的提交、分支和 Worktree 能力处理文件隔离，避免自行设计文件事务和回滚协议，在完整性、可解释性和实现复杂度之间更平衡。

## 17. 当前限制

面试介绍时应主动说明边界：

1. `Explore` 和 `Plan` 仍有 `bash`，不是操作系统级只读沙箱。
2. `AgentRecord` 和后台队列主要保存在内存，进程重启后不能完整恢复正在执行的 SubAgent。
3. Resume 主要用于当前进程内的短期续跑。
4. Worktree 只包含已提交的 HEAD，因此开启隔离前要求主工作区完全干净。
5. Worktree 的结果会保存成独立分支，但不会自动合并，主 Agent 或用户需要审查后决定。
6. 后台并发是异步并发，不是多线程计算并行；主要收益是同时等待多个模型请求和 I/O 操作。
7. SubAgent Memory 是轻量 Markdown 记忆，不具备主长期记忆系统的结构化更新、冲突和压缩能力。

## 18. 面试时的简洁表述

可以按以下顺序介绍：

> 我基于 Pi 的扩展系统实现了一个主从式 Multi-Agent 架构。主 Agent 可以通过统一的 Agent 工具，按注册表创建具有独立系统提示词、模型、工具权限和会话上下文的 SubAgent。SubAgent 内部运行完整 Agent Loop，而不是单次 LLM 调用。
>
> 调度层由 AgentManager 负责，支持前台同步执行、后台异步并发、FIFO 限流队列、任务停止、Steering 和短期 Resume。后台任务先返回 Agent ID，完成后通过 follow-up 消息通知主 Agent，避免破坏一次工具调用对应一次 ToolResult 的协议。
>
> 对需要并行修改代码的任务，我提供了可选的 Git Worktree 隔离。系统从干净的 HEAD 创建 Detached Worktree，SubAgent 的 cwd 指向临时工作区；结束后将修改保存为独立 Commit 和分支，再由主 Agent 审查合并。保存失败时保留 Worktree 现场，避免修改丢失。
>
> 整体上采用中心化编排而不是 Agent 自由通信，主要是为了控制上下文、Token、并发资源和代码冲突，同时保持实现清晰、可测试和可解释。
