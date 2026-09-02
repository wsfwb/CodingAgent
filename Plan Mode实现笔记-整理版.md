# Plan Mode 实现笔记

## 1. 功能定位

Plan Mode 是一个“先规划、后实施”的会话协作模式，主要解决复杂任务中的三个问题：

1. 模型没有充分理解项目和需求就开始修改，早期错误决策影响多个模块。
2. 用户无法在代码变更前审查完整方案、补充约束或否决错误设计。
3. 仅靠自然语言要求“先别修改”缺少可靠的工具、状态和恢复边界。

它的职责边界是：

```text
只读探索项目
→ 澄清重要决策
→ 生成完整实施计划
→ 等待用户批准
→ 退出 Plan Mode
→ 将计划交给原有 Agent Loop 实施
```

Plan Mode 只管理规划和批准边界，不负责逐步骤执行、步骤反思或执行进度跟踪。实施阶段仍由原有主 Agent 根据模型回复和工具结果自行调整。

一句话概括：

> Plan Mode = 系统提示词约束 + 固定工具边界 + Plan 状态机 + 结构化提问/完成协议 + 用户批准后的实施交接。

## 2. 为什么不能只靠 Prompt

简单地在 Prompt 中要求模型“先制定计划，不要修改代码”存在以下问题：

1. `edit`、`write` 等修改工具仍在 Context 中，模型仍可能误调用。
2. 没有结构化完成信号，程序难以区分“正在分析”和“计划已经完成”。
3. 没有正式保存当前有效计划，用户修改需求后可能误用旧计划。
4. 会话恢复时无法确定是否仍处于规划状态、是否已有待批准计划。
5. 缺少结构化提问和用户批准边界。

因此，本实现不是一种 Prompt 技巧，而是一个通过 Pi Extension 接入的会话级运行模式。

## 3. 用户使用方式

```text
/plan                 进入 Plan Mode；如果已经进入，则打开当前状态菜单
/plan <任务>          进入 Plan Mode，并立即提交任务
/plan show            显示当前已完成的计划，不触发模型调用
/plan finalize        要求模型完成计划；若仍有重要决策，则继续提问
/plan implement       执行已保存的计划
/plan exit            退出 Plan Mode 并丢弃计划
/plan off             与 /plan exit 相同
pi --plan             启动 Pi 时直接启用 Plan Mode
```

典型流程：

```text
用户进入 Plan Mode
→ 主 Agent 只读探索代码和配置
→ 必要时调用 plan_mode_question
→ 主 Agent 调用 plan_mode_complete 提交完整计划
→ 状态进入 plan ready
→ 用户选择“执行计划 / 继续规划 / 放弃计划”
```

## 4. Plan Mode 与 Plan SubAgent

二者解决的问题不同，可以共存。

| 对比项 | Plan Mode | Plan SubAgent |
|---|---|---|
| 发起者 | 用户显式进入 | 主 Agent 按需要内部委派 |
| 所在会话 | 主会话 | 独立 SubAgent 会话 |
| 用户参与 | 多轮澄清、修改、批准 | 通常不直接与用户交互 |
| 权限影响 | 将主 Agent 切换到只读规划环境 | 只限制该 SubAgent 自身 |
| 结果用途 | 供用户审查和批准的正式计划 | 供主 Agent 消费的委派结果 |

Plan SubAgent 仍适用于：

- 正常实施中遇到局部复杂设计，需要独立分析；
- 并行比较多个互不依赖的方案；
- 将大量调研放到独立上下文，减少主 Agent 的上下文负担；
- 用户不要求审批，但主 Agent 仍需要内部规划。

如果任务简单、无需并行分析，并且复杂任务总由用户主动进入 Plan Mode，那么 Plan SubAgent 的使用频率会较低。

## 5. 扩展如何接入 Pi

Plan Mode 作为独立 Extension 接入，不修改底层 AI 请求格式，也不把 Plan 专属流程塞进通用 `AgentSession` 或 Agent Loop。

扩展工厂主要完成三类注册：

1. 注册入口：`--plan` Flag 和 `/plan` 命令。
2. 注册工具：`plan_mode_question` 和 `plan_mode_complete`。
3. 注册生命周期 Hook：会话启动/关闭、Agent 启动/结束/稳定、Context 构造、工具调用和思考等级变化等。

关键 Hook 的职责：

| Hook | 职责 |
|---|---|
| `session_start` | 读取配置、从当前会话分支恢复状态、获取 SubAgent gate、恢复工具和 UI |
| `before_agent_start` | 注入 Plan 系统提示词；开始修订时使旧计划失效 |
| `tool_call` | 拦截固定工具集合之外的工具 |
| `context` | 过滤不应再次发给模型的 Plan 协议和旧计划内容 |
| `agent_end` | 兼容旧版 `<proposed_plan>` 完成协议 |
| `agent_settled` | Agent 稳定后展示计划批准菜单 |
| `session_shutdown` | 保存状态、恢复工具和思考等级、释放 SubAgent gate |

这样做的好处是 Plan Mode 与核心 Agent Loop 解耦，扩展失效或关闭后，原有执行流程不受影响。

## 6. 状态机

### 6.1 状态数据

```ts
interface PlanModeState {
  enabled: boolean;
  latestPlan?: string;
  latestPlanSource?:
    | "plan_mode_complete"
    | "legacy_proposed_plan";
  awaitingAction: boolean;

  previousThinkingLevel?: PlanModeFixedThinkingLevel;
  appliedThinkingLevel?: PlanModeFixedThinkingLevel;
  manualThinkingLevel?: PlanModeFixedThinkingLevel;
}
```

字段含义：

- `enabled`：当前会话是否处于 Plan Mode。
- `latestPlan`：当前唯一有效、可实施的完整计划；不保存草稿或历史版本。
- `latestPlanSource`：计划来自新版完成工具还是旧版 XML 兼容协议。
- `awaitingAction`：计划已就绪，正在等待用户选择执行、继续规划或放弃。
- 三个 thinking 字段：用于应用、追踪和恢复 Plan Mode 专用思考等级。

### 6.2 三种逻辑状态

| 状态 | `enabled` | `latestPlan` | `awaitingAction` |
|---|---:|---:|---:|
| `off` | `false` | 无 | `false` |
| `active` | `true` | 无 | `false` |
| `ready` | `true` | 有 | `true` |

状态转换：

```text
off --进入 Plan Mode--> active
active --提交完整计划--> ready
ready --用户提交修订意见并开始新一轮--> active
ready --执行计划--> off + 启动正常实施 Run
active/ready --退出或放弃--> off
```

“继续规划”本身不会立刻删除计划，而是先保持 `ready`，方便用户查看。用户随后提交修改意见并启动新一轮时，`before_agent_start` 才清除旧的可实施计划并回到 `active`，防止旧计划被误执行。

## 7. 只读规划环境

Plan Mode 激活时，主 Agent 的固定工具集合为：

```text
read
bash
grep
find
ls
memory_read          # 长期记忆扩展存在时才启用
plan_mode_question
plan_mode_complete
```

`edit`、`write`、记忆修改工具、`update_plan` 和 SubAgent 工具等都不在集合中。

只读环境由两层共同实现：

1. 工具名硬边界：扩展切换活动工具集合，并由 `tool_call` Hook 再次拦截集合外工具。即使其他扩展重新激活了某个工具，调用时仍会被拒绝。
2. Bash 行为软约束：系统提示词要求 Bash 只能用于读取文件、配置和仓库状态，禁止重定向、修改 Git、安装依赖、格式化或启动服务。

必须准确说明其安全边界：普通修改工具受到程序化阻止，但 Bash 没有命令解析、白名单或 OS 沙箱，Bash 的只读性依赖模型遵守提示词。因此它是工作流约束，不是恶意命令防护边界，只应在可信项目和环境中使用。

没有采用 Bash 子命令白名单，是因为 PowerShell、Bash 等 Shell 语法不同，同一命令可能因参数产生不同副作用，Git 也有大量子命令；不完整白名单会显著损害项目探索能力。

## 8. 规划提示词

每次 Plan Run 开始时，扩展把 Plan 指令追加到原系统提示词，而不是放进普通 `UserMessage`。提示词要求模型：

1. 先读取项目事实，不要凭空假设。
2. 区分能从代码中发现的事实与必须由用户决定的取舍。
3. 对高影响且不可从项目发现的问题进行澄清。
4. 不执行实现、不修改文件。
5. 只有在计划已经 decision-ready 时，才单独调用 `plan_mode_complete`。

“decision-ready”表示实施者不需要重新做重要产品或架构决策。完整计划通常应说明目标、成功标准、用户约束、涉及模块或文件、关键实现方法、验证方式和明确假设。

程序不会用语义解析器验证这些章节是否齐全；语义完整性由系统提示词、模型判断和用户批准共同保证。

## 9. 结构化提问：plan_mode_question

### 9.1 何时调用

该工具是选择性调用，不是每次规划都必须调用。以下条件同时成立时应调用：

- 问题会显著改变实现方案；
- 无法通过只读探索项目得到答案；
- 不能安全地采用默认假设。

每次调用包含 1～3 个问题，优先只问一个。每个问题有 2～4 个互斥选项，存在明确默认值时把推荐项放在第一位；UI 会自动增加 `Other` 自定义输入。

### 9.2 参数示例

```ts
{
  questions: [{
    id: "cache_scope",
    header: "缓存范围",
    question: "缓存应该在哪个范围内生效？",
    options: [
      {
        label: "当前项目",
        description: "多次会话共享，需要项目级持久化。"
      },
      {
        label: "当前会话",
        description: "退出 Pi 后失效，实现最简单。"
      }
    ]
  }]
}
```

多个问题会依次显示，不会同时显示为一张表单；全部回答完成后才一次性返回结果。预设选项的 `optionIndex` 从 1 开始，自定义答案则标记 `wasCustom: true`。

### 9.3 返回和取消

成功结果的核心结构为：

```ts
{
  cancelled: false,
  answers: [{
    id: "cache_scope",
    answer: "当前项目",
    wasCustom: false,
    optionIndex: 1
  }]
}
```

工具返回值包含：

- `content`：序列化后的文本，供下一轮模型读取；
- `details`：原问题、答案和选项位置等结构化数据。

Agent runtime 会把工具返回值包装成 `ToolResultMessage`，加入会话并持久化到 JSONL。下一轮模型因此能看到用户答案并继续规划。

用户取消、`Other` 留空、选项映射失败、参数无效、UI 不可用或 Plan Mode 已关闭时，工具返回 `cancelled: true` 及对应 `reason`。之后：

- 高影响问题仍未解决：模型应改用一条简短普通文本问题继续询问；
- 低风险偏好：可以采用推荐默认值，但必须把假设写进最终计划；
- 参数格式错误：模型应修正参数后重试。

注意：用户在 `Other` 中输入“取消计划并退出”当前只会成为普通自定义答案，不会自动执行 `/plan exit`。真正退出应使用命令或批准菜单。

## 10. 完成协议：plan_mode_complete

### 10.1 为什么需要专用工具

专用完成工具建立了明确、可机读的规划结束边界：

- 不依赖“这是最终计划”等自然语言猜测；
- 保存完整计划和版本化结构数据；
- 将状态切换为 `ready`；
- 给 Agent Loop 返回终止提示；
- 支持从会话记录中恢复计划。

模型必须把它作为最后一个、单独的工具调用：

```ts
plan_mode_complete({
  plan: "# 完整 Markdown 实施计划"
})
```

### 10.2 校验范围

校验分为 JSON Schema 和运行时两层：

- 参数必须是对象且只能包含必填字段 `plan`；
- `plan` 必须是字符串；
- 去除首尾空白后不能是空计划；
- 不能超过 50,000 个 JavaScript 字符。

工具不会判断计划是否真的包含目标、测试或风险，也不会截断过长计划。

### 10.3 返回结果

```ts
{
  content: [{
    type: "text",
    text: "**Proposed Plan**\n\n# 完整计划"
  }],
  details: {
    version: 1,
    source: "plan_mode_complete",
    plan: "# 完整计划"
  },
  terminate: true
}
```

其中：

- `content` 和 `details` 进入最终 `ToolResultMessage` 并保存到 JSONL；
- `terminate` 是工具执行结果给 Agent runtime 的控制提示，不是 `ToolResultMessage` 中的持久化业务字段。

`terminate: true` 是 best-effort 终止提示，不是无条件强制终止。如果模型把完成工具和其他工具放在同一个并行批次中，只有已完成的同批工具也满足终止条件时，runtime 才会提前终止整个批次。因此提示词要求 `plan_mode_complete` 必须单独且最后调用。

若某轮没有产生完整计划，系统不会自动重试，因为探索轮和澄清轮本来就可能合法结束。Plan Mode 会保持 `active`，用户可以继续输入，或使用 `/plan finalize` 明确要求收敛。

旧版 `<proposed_plan>...</proposed_plan>` 仅用于兼容历史会话和旧模型输出，不是当前推荐协议。

## 11. 计划批准、修订与实施交接

### 11.1 批准菜单

计划完成并且 Agent 已稳定后，界面显示：

1. `执行计划`
2. `继续规划`
3. `放弃计划`

### 11.2 执行计划

```text
把 latestPlan 保存到局部变量
→ 退出 Plan Mode 并持久化 off 状态
→ 恢复原工具和思考等级
→ 释放 SubAgent gate
→ 清除 latestPlan/awaitingAction
→ 把完整计划作为新的实施 UserMessage 发送给主 Agent
→ 启动正常 Agent Run
```

实施消息大意为：Plan Mode 已关闭、完整工具已经恢复，请立即实施以下计划。此时已不处于 `plan ready`，主 Agent 可以调用写工具、记忆工具和 SubAgent。

如果当前 Pi 进程仍在，但发送实施消息同步失败，扩展会重新进入 Plan Mode，并用局部变量恢复 `ready` 状态，避免计划立即丢失。

### 11.3 继续规划

选择“继续规划”后仍保留当前完整计划。用户可以先查看计划，再发送修改意见。下一轮开始前旧计划会失效，模型必须提交一份完整替代计划，而不是只提交差异。

如果用户只询问计划含义而没有要求修改，模型回答后也应重新提交完整的未修改计划，使其重新回到可批准状态。

### 11.4 放弃或退出

“放弃计划”、`/plan exit` 和 `/plan off` 都会退出 Plan Mode，恢复原工具和思考等级，释放 SubAgent gate，并清除已保存计划。退出不是实施请求。

## 12. 持久化和恢复

Plan 状态以完整快照追加到当前会话 JSONL：

```json
{
  "type": "custom",
  "customType": "plan-mode-state",
  "data": {
    "enabled": true,
    "latestPlan": "# API 缓存计划",
    "latestPlanSource": "plan_mode_complete",
    "awaitingAction": true
  },
  "id": "...",
  "parentId": "...",
  "timestamp": "..."
}
```

它是供扩展恢复状态的 `CustomEntry`，不是对话消息，所以会保存在 JSONL 中，但不会作为普通 `UserMessage`、`AssistantMessage` 或 `ToolResultMessage` 发给模型。

扩展会在进入、完成、修订、退出、思考等级变化和会话关闭等相关时机追加新快照，而不是覆盖旧行。恢复时只检查当前活动分支，找到最后一个合法的 `plan-mode-state`，因此会话分叉后不会错误读取其他分支的 Plan 状态。

正常恢复以状态快照为准。防御性兼容逻辑还可以在最新状态快照之后查找有效的 `plan_mode_complete` ToolResult：只有状态中缺少合法计划时才使用它，不是日常恢复主路径。

典型恢复场景：用户在 `active` 或 `ready` 状态关闭 Pi，重新启动并 resume 原会话，扩展据 JSONL 恢复模式、计划和 UI。

## 13. Context 清理

JSONL 需要保留完整历史用于审计和恢复，但并非所有内部协议内容都应再次发送给模型。因此 `context` Hook 会按当前状态过滤消息：

- Plan Mode 中：过滤旧版 Plan 内部上下文和历史实施交接消息，避免模型误以为正在执行旧计划。
- Plan Mode 关闭后：过滤已失效的计划展示消息、完成工具结果、完成工具调用和旧 XML 计划块。
- 因过滤而变空的 AssistantMessage 也会移出模型 Context。

实施交接产生的新 `UserMessage` 会保留在正常执行 Context 中，主 Agent 后续仍能依据完整计划工作。

这里区分了两个概念：JSONL 是持久化历史；Context 是某一轮真正发给模型的消息快照。过滤 Context 不会删除 JSONL 数据。

## 14. 思考等级

可选配置文件为：

```text
~/.pi/agent/pi-plan-mode.json
```

```json
{
  "thinkingLevel": "inherit"
}
```

支持 `inherit`、`off`、`minimal`、`low`、`medium`、`high`、`xhigh` 和 `max`。默认 `inherit`，即沿用主 Agent 当前思考等级。

若配置固定等级，进入 Plan Mode 时记录原等级并应用新等级；退出时仅在当前等级仍是扩展所设置的值时才恢复。用户在 Plan Mode 中手工修改过思考等级时，以用户的新选择为准，不会被扩展错误覆盖。

## 15. 与 Multi-Agent 和长期记忆的协调

### 15.1 Multi-Agent

同一 Pi 进程中，规划阶段和 SubAgent 执行互斥：

- 有 SubAgent 正在运行或排队时，拒绝进入或恢复 Plan Mode；
- Plan Mode 持有 gate 时，拒绝新建和恢复 SubAgent；
- 用户批准实施后，Plan Mode 先释放 gate，再启动正常实施 Run，主 Agent 此时可以使用 SubAgent。

该 gate 通过 `Symbol.for("pi-subagents:manager")` 找到 SubAgent Manager，是进程内协调机制。另一个 Pi 进程不受此 gate 管理。

### 15.2 长期记忆

全局和项目记忆索引已经属于基础系统提示词的一部分。Plan Mode 可选启用 `memory_read` 读取主题细节，但禁止 `memory_create`、`memory_update` 和 `memory_forget`，防止规划阶段产生持久化副作用。

由于活动工具中没有记忆修改工具，任务后的 Curator 不会在规划阶段写记忆。进入实施阶段后，正常记忆能力恢复。

## 16. 明确限制

1. Bash 只读依赖系统提示词，不是 OS 沙箱或安全边界。
2. SubAgent gate 只覆盖同一 Pi 进程，不能阻止其他进程修改同一项目。
3. Plan Mode 不自动判断复杂度，也不会自动触发，进入权由用户控制。
4. `plan_mode_complete` 只做结构和长度校验，不验证语义完整性。
5. 实施阶段没有结构化步骤游标、逐步骤状态或自动反思机制。
6. resume 可以恢复规划状态，但不会自动恢复并继续一个中断的实施流程。
7. 存在很小的崩溃窗口：已持久化 `off` 状态、但实施 `UserMessage` 尚未成功持久化时若整个进程崩溃，计划不会自动重新交接。
8. `Other` 中的自然语言不会被解释为 `/plan exit` 等控制命令。

这些限制是有意的复杂度取舍，不应在面试中把该功能描述成安全沙箱或完整工作流引擎。

## 17. 设计演变

### 17.1 被删除的旧方案

旧方案试图把 Plan Mode 做成完整执行工作流：

- 自动复杂度评分或额外 LLM 判断是否进入 Plan Mode；
- 生成和批准计划；
- 跟踪每个执行步骤；
- 每步结束后反思并调整剩余计划；
- 对步骤失败进行重试；
- 保存大量执行和恢复状态。

它的问题包括：

- 与原有 Agent Loop 的工具执行和重试职责重复；
- 计划、步骤、反思、压缩和会话恢复相互耦合；
- 崩溃时难以判断文件已修改但步骤是否完成；
- 修订计划可能丢失旧约束；
- 容易把旧 AssistantMessage 当成本次步骤结果；
- Plan 专属逻辑侵入通用 `AgentSession` 和压缩流程；
- 自动触发需要额外模型调用，而且判断结果不可预测。

### 17.2 当前方案

当前实现缩小了职责：

```text
Plan Mode 负责“形成并批准决策完整的计划”
原有 Agent Loop 负责“实施、观察工具结果并动态调整”
```

这不是简单删功能，而是重新划分系统边界：Plan Mode 提供只读性、计划持久化、会话恢复和批准协议；执行可靠性继续复用已经成熟的 Agent Loop。

## 18. 面试表述

可以这样概括：

> 我将 Plan Mode 实现为 Pi 的会话级 Extension，而不是侵入核心 Agent Loop。规划阶段通过固定工具集合和 `tool_call` Hook 阻止写工具，通过结构化问题工具澄清高影响决策，再用版本化的完成工具建立明确的计划完成边界。完整计划和模式状态以 CustomEntry 快照写入会话 JSONL，支持活动分支恢复；用户批准后，扩展先恢复工具和思考等级、释放 SubAgent gate，再把完整计划作为新的 UserMessage 交回原 Agent Loop 执行。这样既保证了用户在修改前能够审查方案，也避免重新实现一套复杂且容易与现有执行循环冲突的工作流引擎。

如果面试官追问安全性，应明确补充：

> 普通写工具受程序化工具边界限制，但 Bash 的只读性仍是提示词约束，不是 OS 级沙箱；SubAgent 协调也只覆盖当前 Pi 进程。
