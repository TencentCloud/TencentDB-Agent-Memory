# TencentDB Agent Memory Claude Code 插件

本插件基于 #316 提供的统一 Gateway Adapter，将 Claude Code 生命周期 Hook 接入 TencentDB Agent Memory。

- `UserPromptSubmit`：调用 `prefetch()`，通过 Gateway `/recall` 召回记忆。
- `Stop`：调用 `captureTurn()`，通过 Gateway `/capture` 保存本轮用户输入和 assistant 回复。
- `SessionStart`：调用 `health()`，通过 Gateway `/health` 检查 Gateway 状态。
- `SessionEnd`：调用 `endSession()`，通过 Gateway `/session/end` 刷新会话。
- 当 prompt cache 不可用时，从 Claude Code transcript 恢复本轮内容。
- 不重复实现 MCP Server，主动记忆搜索由 #372 的通用 MCP Bridge 提供。

## 前置条件

- Node.js 版本不低于 22.16。
- Claude Code 支持插件和命令 Hook。
- 在仓库根目录执行过 `npm install`。
- 已按照仓库根 README 配置 Gateway 所需的模型和 Provider 环境变量。

在仓库根目录单独运行 Claude Code 测试：

```text
npx.cmd vitest run --config claudecode-plugin/vitest.config.ts
```

## 1. 配置 Gateway 连接

Windows `cmd.exe`：

```bat
set TDAI_GATEWAY_URL=http://127.0.0.1:8420
set TDAI_GATEWAY_API_KEY=replace-with-your-key
```

Windows PowerShell：

```powershell
$env:TDAI_GATEWAY_URL = "http://127.0.0.1:8420"
$env:TDAI_GATEWAY_API_KEY = "replace-with-your-key"
```

bash/zsh：

```bash
export TDAI_GATEWAY_URL=http://127.0.0.1:8420
export TDAI_GATEWAY_API_KEY=replace-with-your-key
```

Gateway 和 Claude Code 必须使用同一个 Bearer Token。Gateway 未启用鉴权时，可以省略 `TDAI_GATEWAY_API_KEY`。

## 2. 手动启动 Gateway

在仓库根目录启动 Gateway，并保持终端运行：

```text
node --import tsx src/gateway/server.ts
```

另开终端验证：

```text
curl http://127.0.0.1:8420/health
```

本插件不会自动启动或停止 Gateway。

## 3. 启动 Claude Code 插件

在你希望 Claude Code 操作的项目目录中执行。将
`<path-to-TencentDB-Agent-Memory>` 替换为仓库实际路径：

```text
claude --plugin-dir "<path-to-TencentDB-Agent-Memory>\claudecode-plugin\memory\memory_tencentdb"
```

Claude Code 的当前工作目录可以是任意项目目录，插件路径可以使用绝对路径。
macOS 或 Linux 使用对应的路径格式。Claude Code 请求 Hook 授权时，检查并信任
`SessionStart`、`UserPromptSubmit`、`Stop` 和 `SessionEnd` 四个命令。

## 4. 验证记忆调用

正常使用 Claude Code 即可。Gateway 终端应显示：

```text
Recall completed in ...ms: context=... chars
Capture completed in ...ms: l0=...
```

会话启动时还应看到 `/health` 请求，会话结束时应看到 `/session/end` 请求。

recall Hook 会把用户输入保存到短期跨进程缓存。capture 阶段无法读取缓存时，会回退读取 Claude Code transcript。Gateway 请求失败时，插件不会阻塞 Claude Code。

## 5. 停用插件

不再使用 `--plugin-dir` 启动 Claude Code，或者关闭当前 Claude Code 会话后，在不带插件参数的情况下重新启动。若不再使用 Gateway，也可以关闭 Gateway 终端。上述操作不会删除 `~/.memory-tencentdb` 中已经保存的记忆数据。
