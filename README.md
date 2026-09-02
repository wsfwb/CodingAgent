# Customized Pi

这是一个基于 Pi 修改和扩展的终端 Coding Agent，保留原有多模型、工具调用和会话能力，并增加了更适合个人开发流程的功能。

## 主要功能

- **Plan Mode**：修改代码前先进行只读分析、澄清需求并生成可确认的实施计划。
- **Multi-Agent**：主 Agent 可以委派独立 SubAgent 进行搜索、分析、修改和复查，并支持后台并发与主动停止。
- **跨会话长期记忆**：按主题保存重要偏好、项目知识和经验，并在后续会话中按需召回。

## Windows 安装

安装 Node.js 22.19.0 或更高版本，然后在仓库根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

安装完成后，可以在电脑任意目录运行：

```cmd
pi
```

首次使用时，在 Pi 中通过 `/login` 配置自己的模型认证。

安装后请保留仓库目录，不要移动或删除，因为全局命令和扩展配置会引用这里的代码。

本仓库不包含 API Key、OAuth 凭证、会话记录或作者的个人长期记忆内容。
