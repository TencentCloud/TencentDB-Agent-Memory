# Cursor 适配器

该适配器无需接管模型请求，也不依赖具体模型供应商，通过 Cursor Hook + MCP 为 Cursor 提供跨会话 TencentDB Agent Memory：

- `sessionStart` 召回长期上下文并注入新 Composer 会话；
- `beforeSubmitPrompt` 与 `afterAgentResponse` 使用稳定的 `conversation_id` 和每轮唯一的 `generation_id` 配对完整对话，再幂等写入 Gateway `/capture`；
- `sessionEnd` 通知记忆流水线刷新；
- MCP 为 Cursor Auto 和具名模型提供主动召回与搜索工具。

模型请求仍走 Cursor 原生供应商链路，因此 Cursor Free 的 Auto 模型也能使用，不需要自定义模型或修改 OpenAI Base URL。

## 模型与套餐兼容性

本适配器有意让模型请求继续走 Cursor 原生供应商链路。Cursor Free 账号可能只能使用 **Auto** 模型，具名模型是否可用取决于用户的 Cursor 套餐和账号权限；本适配器不会绕过这些限制。

本适配器使用 Cursor 公开的 Agent Hooks 和 MCP 接口，而不是替换 Cursor 的模型 endpoint：

- Hook 运行在 Cursor 的会话和 Agent 生命周期节点；
- `sessionStart` 在 Agent 开始工作前召回 TencentDB Agent Memory；
- `beforeSubmitPrompt` 与 `afterAgentResponse` 捕获并配对完整对话；
- MCP 工具允许当前 Agent 主动召回和搜索记忆；
- 模型请求仍由 Cursor 根据用户选择的供应商发送。

采用这个设计，可以让没有具名模型权限的 Cursor Free/Auto 用户使用记忆能力，不依赖某个具体模型供应商，不要求把 Cursor 的模型 endpoint 替换为 TencentDB Proxy，也不会修改 Cursor 的账号、计费、模型权限或供应商配置。用户套餐允许时，具名模型同样可以使用本适配器；具体模型是否可用仍由 Cursor 决定。

## 前置条件

- 支持 Agent Hooks 和本地插件的 Cursor
- Node.js 22 或更高版本
- 已启动的 TDAI Gateway（默认 `http://127.0.0.1:8420`）

Gateway 已原生提供 `/recall`、`/capture`、`/search/memories`、`/search/conversations` 和 `/session/end`；本目录仅实现 Cursor 到这些官方接口的薄适配层。

## 安装

推荐使用安装器。它会定位当前 Node 可执行文件和 Cursor 本地插件目录，并生成本机启动器，规避 Cursor 扩展宿主找不到 `node`、MCP 相对路径按工作区解析、`${PLUGIN_ROOT}` 不展开等问题：

```powershell
node .\adapters\cursor\scripts\install.mjs
```

预览而不写入：

```powershell
node .\adapters\cursor\scripts\install.mjs --dry-run
```

自定义安装目录：

```powershell
node .\adapters\cursor\scripts\install.mjs --target D:\cursor-plugins\tencentdb-agent-memory
```

默认安装到：

```text
~/.cursor/plugins/local/tencentdb-agent-memory
```

重启 Cursor，或执行 `Developer: Reload Window`。然后在 **Customize → Plugins** 中配置：

- `TDAI_GATEWAY_URL`：Gateway 地址；
- `TDAI_GATEWAY_API_KEY`：可选的 Gateway Bearer Token，禁止提交到仓库；
- `TDAI_CURSOR_AGENT_ID`：稳定的 Cursor 记忆范围，默认为 `cursor`。不同项目需要隔离时应使用不同值。

Gateway 中的 `session_key` 为 `agent:<agent-id>:cursor`，Cursor 原始 `conversation_id` 作为 `session_id` 保留。新 Composer 有不同的会话 ID，但仍共享这个 Cursor 记忆范围。其他客户端只有显式采用相同 `session_key` 或服务端提供统一的 Agent 隔离映射时才能共享，不能仅凭名称相同推断已经跨客户端共享。

> `TDAI_GATEWAY_API_KEY` 是 Gateway Bearer Token，不等同于 MemoryProxy 的业务用户 `user_key`。不要把任何密钥提交到仓库或粘贴到公开 Issue/PR；已暴露的密钥应立即轮换。

## MCP 工具

- `memory_status`：检查 Gateway 和当前记忆范围；
- `memory_recall`：按相关性召回长期记忆；
- `memory_search`：搜索抽取后的长期记忆；
- `conversation_search`：搜索原始 L0 对话。

内置 Always Rule 会在历史工作可能有帮助时引导 Cursor 调用这些工具。召回内容被明确视为不可信数据，而不是指令。

## 验收测试

1. 使用 **Auto** 模型打开 Composer A；
2. 发送：`项目发布代号是“北斗青鸟”，部署窗口为每周四晚上九点。`；
3. 确认 Gateway `/capture` 只记录一轮，且使用当前 Cursor conversation ID；
4. 在同一 Composer 继续对话，确认 `conversation_id` 不变而 `generation_id` 改变；
5. 新建 Composer B，询问：`项目发布代号和部署窗口是什么？`；
6. 确认 `memory_recall` 返回“北斗青鸟”和“每周四晚上九点”；
7. 重放一次相同 `afterAgentResponse` 输入，确认不会重复写入；
8. 停止 Gateway，确认 Cursor 仍可正常工作：Hook 采用 fail-open，只在 Hook 输出通道记录诊断。

## 已验证能力

| 能力 | 状态 |
| --- | --- |
| Cursor Free / Auto | 已本地验证 |
| Hook 自动配对与捕获 | 已本地验证 |
| MCP 状态、召回和搜索工具 | 已本地验证 |
| Windows 中文 Hook 输入 | 已验证；损坏 JSON 救援并优先读取 UTF-8 transcript |
| 本地 Gateway SQLite L0 | 已验证 |
| Gateway 离线 fail-open | 已验证 |
本适配器的验证针对 Cursor 客户端、Hook、MCP 和已配置的 Gateway 接口；存储后端和 Gateway 部署方式由使用者配置。

## Cursor 兼容性说明

- Cursor 3.17.8 Windows 的 Hook 启动链可能在 Node 读取 stdin 前错误转换中文编码。本适配器能救援可逆乱码；对已经丢失为 `?` 的字符，会从 Cursor UTF-8 transcript 读取本轮原文。
- `beforeSubmitPrompt` 时 transcript 可能还没有当前用户消息，因此只在 `afterAgentResponse` 时用 transcript 同时校正本轮用户和助手内容，避免串到上一轮。
- Cursor 关闭窗口时，`sessionEnd` 可能由 Cursor 报 `MainThreadShellExec not initialized`。完整对话已在 `afterAgentResponse` 捕获，正确性不依赖 `sessionEnd`。
- 未完成的 pending 轮次保留 7 天，幂等标记保留 30 天，之后自动清理。

## 能力边界

Hook + MCP 可以召回、搜索和捕获对话；模型请求仍由 Cursor 按其原生配置发送，适配器不拦截或改写模型供应商请求。记忆层的进一步处理由 Gateway 按其自身配置负责。
