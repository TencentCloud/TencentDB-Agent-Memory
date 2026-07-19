# TencentDB Agent Memory Codex 插件

本插件基于 #316 提供的统一 Gateway Adapter，将 Codex 的生命周期 Hook 接入 TencentDB Agent Memory。

- `UserPromptSubmit`：调用 `prefetch()`，通过 Gateway `/recall` 召回记忆，并作为 additional context 返回给 Codex。
- `Stop`：读取本轮用户输入和 assistant 最终回复，调用 `captureTurn()`，通过 Gateway `/capture` 保存会话。
- 记忆搜索工具由 #372 的通用 MCP Bridge 提供，本插件不重复实现 MCP Server。

## 前置条件

- Node.js 版本不低于 22.16。
- Codex CLI 支持插件和命令 Hook。
- 在仓库根目录执行过 `npm install`。
- 已按照仓库根 README 配置 Gateway 所需的模型和 Provider 环境变量。

在仓库根目录单独运行 Codex 测试：

```text
npx.cmd vitest run --config codex-plugin/vitest.config.ts
```

## 1. 配置环境变量

Gateway 和 Codex Hook 必须使用相同的 Gateway 地址及 Bearer Token。

Windows `cmd.exe`：

```bat
set TDAI_GATEWAY_URL=http://127.0.0.1:8420
set TDAI_GATEWAY_API_KEY=replace-with-your-key
set TDAI_MEMORY_ROOT=.
```

Windows PowerShell：

```powershell
$env:TDAI_GATEWAY_URL = "http://127.0.0.1:8420"
$env:TDAI_GATEWAY_API_KEY = "replace-with-your-key"
$env:TDAI_MEMORY_ROOT = "."
```

bash/zsh：

```bash
export TDAI_GATEWAY_URL=http://127.0.0.1:8420
export TDAI_GATEWAY_API_KEY=replace-with-your-key
export TDAI_MEMORY_ROOT=.
```

`TDAI_MEMORY_ROOT` 必须指向仓库根目录。上面的示例使用相对路径 `.`，因此需要从仓库根目录启动 Codex。Hook 通过该变量引用仓库中已有的 #316 Adapter 源码，不会额外复制 Gateway Client 或 Adapter SDK。

如果使用 Windows Codex 桌面应用，需要使用 `setx` 设置持久环境变量，并完全退出后重新启动 Codex：

```bat
setx TDAI_GATEWAY_URL "http://127.0.0.1:8420"
setx TDAI_GATEWAY_API_KEY "replace-with-your-key"
setx TDAI_MEMORY_ROOT "."
```

Gateway 未启用鉴权时，可以省略 `TDAI_GATEWAY_API_KEY`。

## 2. 手动启动 Gateway

在仓库根目录启动 Gateway，并保持该终端运行：

```text
node --import tsx src/gateway/server.ts
```

另开终端检查 Gateway：

```text
curl http://127.0.0.1:8420/health
```

如果 Gateway 启用了鉴权，请在请求中携带：

```text
Authorization: Bearer <your-key>
```

本插件不会自动启动或停止 Gateway。

## 3. 手动配置 Codex 插件

在仓库根目录执行以下命令，将仓库中的 `codex-plugin` 注册为本地 Marketplace。Marketplace 清单位于 `codex-plugin/.agents/plugins/marketplace.json`，请保持这个目录结构不变：

```text
codex plugin marketplace add .\codex-plugin
codex plugin add tencentdb-memory@tencentdb-agent-memory-local
```

确认插件已被 Codex 发现：

```text
codex plugin list
```

重新启动 Codex 或新建任务。首次运行时，检查并信任 `UserPromptSubmit` 和 `Stop` 两个命令 Hook。不要使用全局跳过 Hook 信任检查的方式运行 Codex。

## 4. 使用和验证

正常使用 Codex 即可。每次提交用户输入时，插件调用 `/recall`；本轮结束时，`Stop` Hook 调用 `/capture`。

Gateway 终端应能看到 `/recall` 和 `/capture` 请求。如果没有请求，请依次检查：

1. Codex 插件是否已启用。
2. 两个 Hook 是否已信任。
3. Codex 是否继承了 `TDAI_GATEWAY_URL`、`TDAI_GATEWAY_API_KEY` 和 `TDAI_MEMORY_ROOT`。
4. Gateway 是否仍在运行，且地址与 `TDAI_GATEWAY_URL` 一致。

## 5. 停用和移除

停用插件但保留已经保存的记忆：

```text
codex plugin remove tencentdb-memory@tencentdb-agent-memory-local
```

如果不再使用本地 Marketplace，可以继续执行：

```text
codex plugin marketplace remove tencentdb-agent-memory-local
```

最后关闭运行 `src/gateway/server.ts` 的终端。上述操作不会删除 `~/.memory-tencentdb` 中已经保存的记忆数据。
