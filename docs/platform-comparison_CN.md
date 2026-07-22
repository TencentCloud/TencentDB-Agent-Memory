# Codex、Claude Code 与 OpenCode 接入对比

Codex、Claude Code 和 OpenCode 都使用同一个 Gateway 与共享 stdio MCP server 接入 TencentDB Agent Memory。三者的主要差异在于平台提供的生命周期能力：Codex 与 Claude Code 使用 command Hook，OpenCode 还提供原生 plugin。

三个生命周期集成都实现公开的 `PlatformAdapter` 契约。平台代码只负责提取原生事件与消息结构，共享 runtime 负责 Gateway 访问、fail-open、操作去重和关闭协调。接入其他平台请查看[使用 Adapter SDK 接入新平台](adapter-sdk_CN.md)。

本文用于帮助你选择接入方式。具体安装命令和各平台排障步骤请查看对应的接入指南。

| 维度               | Codex                                | Claude Code                               | OpenCode                                          |
| ------------------ | ------------------------------------ | ----------------------------------------- | ------------------------------------------------- |
| 自动生命周期机制   | Command Hook                         | Command Hook                              | 原生 plugin                                       |
| 共享 MCP server    | 是                                   | 是                                        | 是                                                |
| 自动 recall        | `UserPromptSubmit`                   | `UserPromptSubmit`                        | `chat.message`，随后注入 system context           |
| 自动 capture       | `Stop`                               | 无后台任务或定时唤醒时的 `Stop`           | `session.status` 的 `idle`，或旧版 `session.idle` |
| 自动 session flush | 不支持：Codex 没有 `SessionEnd` Hook | `SessionEnd`                              | `session.deleted`                                 |
| 上下文注入         | Hook `additionalContext`             | Hook `additionalContext`                  | `experimental.chat.system.transform`              |
| 分发方式           | 使用已安装依赖的仓库 checkout        | 使用已安装依赖的仓库 checkout             | plugin 与 MCP 命令均使用已发布 npm 包             |
| 平台状态目录       | `~/.memory-tencentdb/codex-adapter`  | `~/.memory-tencentdb/claude-code-adapter` | `~/.memory-tencentdb/opencode-adapter`            |

## 三个平台的共同能力

所有接入方式都连接到同一个 Gateway，默认地址为 `http://127.0.0.1:8420`。共享 MCP server 对模型暴露相同的工具：

- `tdai_memory_recall`
- `tdai_memory_capture`
- `tdai_session_end`
- `tdai_memory_search`
- `tdai_conversation_search`

自动 recall 和 capture 是确定性的生命周期动作，不依赖模型是否决定调用 MCP 工具。模型需要更多历史细节时，仍可主动调用 search 工具。

每个 adapter 都支持 `TDAI_GATEWAY_URL` 与 `TDAI_GATEWAY_API_KEY`。当前一个 Gateway 实例对应一个记忆命名空间；这些变量不提供用户级命名空间隔离。Capture 使用 at-least-once 投递语义：若 Gateway 已接受请求，但本地成功标记尚未写入就退出，后续重试会复用稳定 message ID，供下游存储去重。

## Codex：适合最小化的 Hook 接入

Codex 在 `UserPromptSubmit` 时 recall，在 `Stop` 时 capture 最终 turn。两个事件都通过 command Hook 运行 Codex adapter，并直接调用共享 Gateway HTTP client；独立 MCP server 仍用于模型主动调用工具。

Codex 没有 `SessionEnd` Hook，因此 session 结束时无法自动调用 `tdai_session_end`。这是它相较 Claude Code 和 OpenCode 的主要生命周期差异。

当你的工作流已经使用 Codex 的 Hook 与 MCP 配置，且不要求自动 session flush 时，选择 Codex。

安装与排障请查看 [Codex 接入指南](codex_CN.md)。

## Claude Code：适合完整的 Hook 生命周期

Claude Code 与 Codex 一样使用 command Hook，但额外提供 `SessionEnd` 事件。adapter 会在 `UserPromptSubmit` 时 recall，在 `Stop` 时 capture，并在 `SessionEnd` 时刷新已排队工作。

当 `background_tasks` 或 `session_crons` 非空时，`Stop` handler 会跳过 capture，避免把仍在等待后台工作的暂停状态写成最终回复。需要 Claude Code `v2.1.196` 或更高版本，因为 adapter 使用 `prompt_id` 在独立 Hook 进程间稳定关联 prompt 与 reply。

当你希望采用 Hook 接入，同时需要自动 session flush，并避免捕获仍在后台执行中的 turn 时，选择 Claude Code。

安装与排障请查看 [Claude Code 接入指南](claude-code_CN.md)。

## OpenCode：适合原生 plugin 生命周期控制

OpenCode 使用两条互补通道：

- 原生 plugin 自动执行 recall、system context 注入、capture 和 session flush。
- 共享 stdio MCP server 向模型提供按需记忆工具。

Plugin 会把 recall 内容注入 system context，不修改用户消息或 transcript。Session 进入 idle 后，plugin 读取消息历史，只 capture 最新的完整 user/assistant turn；不会 capture reasoning、tool output、synthetic text、ignored text、失败回复、未完成回复或被中断回复。

OpenCode 目前使用 legacy `experimental.chat.system.transform` Hook 注入 system context。Plugin 同时兼容当前 `session.status` idle 事件和已 deprecated 的 `session.idle` 事件。生产 smoke test 应记录 OpenCode 版本；未来迁移 V2 plugin API 时，需要为 experimental 注入点找到稳定替代方案。

当你需要 plugin 级生命周期控制、精确筛选完整 turn，以及不改动 transcript 的 system context 注入时，选择 OpenCode。

安装与排障请查看 [OpenCode 接入指南](opencode_CN.md)。

## 对比故障降级与重试

三种接入方式都采用 fail-open：记忆服务故障不会阻塞 Agent 的 turn 或 session 关闭。Recall 失败会保留原始 prompt 或 context；capture 失败会保留或释放本地状态，以便后续生命周期事件重试。

不同平台的重试时机如下：

| 平台        | Capture 重试时机                  |
| ----------- | --------------------------------- |
| Codex       | 后续重复触发的 `Stop` 事件        |
| Claude Code | 后续重复触发的 `Stop` 事件        |
| OpenCode    | 本地 claim 释放后的后续 idle 事件 |

## 配置正确的平台入口

| 平台        | 配置生命周期自动化                                                   | 配置 MCP                                                 |
| ----------- | -------------------------------------------------------------------- | -------------------------------------------------------- |
| Codex       | `~/.codex/hooks.json` 或 `<project>/.codex/hooks.json`               | `~/.codex/config.toml` 或 `<project>/.codex/config.toml` |
| Claude Code | `~/.claude/settings.json` 或 `<project>/.claude/settings.json`       | 项目 `.mcp.json` 或 `claude mcp add`                     |
| OpenCode    | `opencode.json` 或 `~/.config/opencode/opencode.json` 的 plugin 配置 | 同一 OpenCode 配置中的 `mcp` 区段                        |

所有平台都应先启动并检查 Gateway，再排查客户端接入：

```bash
curl http://127.0.0.1:8420/health
```

然后使用平台对应的检查入口：Codex 或 Claude Code 中的 `/mcp` 与 `/hooks`，或 OpenCode 中的 `opencode mcp list`。

## 阅读详细接入说明

- [Codex](codex_CN.md)
- [Claude Code](claude-code_CN.md)
- [OpenCode](opencode_CN.md)
- [English comparison guide](platform-comparison.md)
