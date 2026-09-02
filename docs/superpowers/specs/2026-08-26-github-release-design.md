# GitHub 完整版本发布设计

## 目标

将当前定制版 Pi 的完整源码发布到私有 GitHub 仓库默认分支 `main`，使同学克隆后能够通过一条 PowerShell 命令完成全局安装，并在任意目录使用。

## README 范围

根目录 README 保持简洁，只包含：

- 项目的一句话介绍；
- Plan Mode、Multi-Agent、跨会话长期记忆三项核心能力；
- Windows 环境要求和一键安装命令；
- 在任意目录启动 Pi 和首次认证方式；
- 不包含认证信息、会话记录和个人记忆的说明。

实现原理、架构和测试细节不写入 README，由单独的实现笔记承担。

## 发布范围

- 提交 `stop_subagent`、父任务取消级联和相关测试；
- 提交 Multi-Agent 与 Plan Mode 两份实现笔记；
- 更新简洁 README；
- 保留已提交的全局安装脚本、长期记忆、Plan Mode 和 Multi-Agent 代码；
- 不提交内容过时的 `初步使用文档.md`；
- 不提交 API Key、OAuth 凭证、会话记录或个人记忆内容。

## 验证与推送

运行 SubAgent 聚焦测试、全局配置测试和完整离线构建。验证通过后，将完整提交推送到 `codex/plan-mode`，再快进本地 `main` 到同一提交并推送，使 GitHub 默认页面直接展示完整版本。
