# FIX 交接文档：插件运行时变量展开修复（进行中）

> 状态快照：2026-07-29。核心修复已完成并通过双平台端到端验证，e2e 测试已修复（13 全绿），临时文件已清理，记忆已更新。**剩余：用户交互式重测 + 提交/PR**。
> 本文档供新会话直接接手，无需重新排查。

---

## 1. 背景：用户实测报告的两个故障

在 Whale / Codex 两个 CLI 上安装 memory-tdai 插件后实测：

| 平台 | 现象 |
|---|---|
| Codex | `MCP client for memory-tdai failed to start: handshaking with MCP server failed: connection closed: initialize response`（Gateway `/health` 本身正常） |
| Whale | UserPromptSubmit hook 触发但报 `Cannot find module 'C:\scripts\recall.js'` —— `${WHALE_PLUGIN_ROOT}` 展开为空串 |

## 2. 根因（已实证，非猜测）

用二进制字符串取证（whale.exe / codex.exe）+ 环境转储实证（篡改安装缓存配置指向 dump 脚本，捕获宿主真实 spawn 的 cwd/argv/env）得出**宿主 `${VAR}` 展开矩阵**：

| 通道 | 执行方式 | `${VAR}` 展开 | 子进程 env | 结论 |
|---|---|---|---|---|
| Codex hook | Git Bash | ✅ 展开 | 含 `CLAUDE_PLUGIN_ROOT`、`PLUGIN_ROOT` | 正常，**不要动 hooks.json** |
| Codex MCP | 直接 spawn | ❌ 原样传递 | **被净化为空**（无任何插件变量） | 但 `"cwd": "."` 会被 loader 解析为**插件根目录**（实测 srv-a/b/c 三配置只有它成功） |
| Whale hook (Windows) | `PowerShell -NoLogo -NoProfile -NonInteractive -Command` | ❌ `${VAR}` 是未定义 PS 变量→空串 | 含 `WHALE_PLUGIN_ROOT` | 用户报错根因 |
| Whale MCP | 直接 spawn | ❌ 原样传递 | 含 `WHALE_PLUGIN_ROOT`（还有 `WHALE_PLUGIN_DATA_DIR`、`WHALE_PLUGIN_PROJECT_DIR`） | 可从 env 解析 |

## 3. 已完成的三个修复（不要回退）

修复原则（沿用之前 bash→WSL 问题的经验）：**不依赖宿主 `${VAR}` 展开，路径解析全部移进 Node 内部，零外部依赖**。

### 3.1 `whale-memory-tdai/hooks.toml` —— 4 个 hook 全部改 env 解析启动器

```toml
[[hooks.UserPromptSubmit]]
command = "node -e \"import(require('node:url').pathToFileURL((process.env.WHALE_PLUGIN_ROOT||'.')+'/scripts/recall.js').href).catch(()=>process.exit(0))\""
```

要点：`pathToFileURL` 解决 Windows 盘符路径不能直接 dynamic import；`.catch(()=>process.exit(0))` 保持静默失败不变量；该写法 PS / bash / sh 三 shell 兼容（无 `$`、反引号等 shell 特殊字符冲突）。

### 3.2 `whale-memory-tdai/mcp.json` —— args 改 `-e` + env 解析

```json
"args": ["-e", "import(require('node:url').pathToFileURL((process.env.WHALE_PLUGIN_ROOT||'.')+'/mcp-bridge.js').href)"]
```

### 3.3 `codex-memory-tdai/.mcp.json` —— 相对路径 + cwd

```json
{ "mcpServers": { "memory-tdai": { "command": "node", "args": ["./mcp-bridge.js"], "cwd": "." } } }
```

### 3.4 验证结果（均已通过）

- 本地冒烟：whale MCP 启动器 initialize 成功；PS 模拟 whale hook 调用 exit 0
- 重装两平台插件后**端到端无头验证双双通过**：
  - Codex: `codex exec --dangerously-bypass-hook-trust ...` → `mcp: memory-tdai/search_memories started → completed`
  - Whale: `whale exec --dangerously-skip-permissions ...` → `data: {"server":"memory-tencentdb.memory-tdai","tool":"search_memories"}`
- 空召回是正常业务结果：直接 `POST /recall` 返回 `{"context":"","memory_count":0}`
- `npm test`：120 全绿

## 4. 【当前唯一未解决问题】npm run test:e2e 3 个失败

```
FAIL e2e/plugins/whale-codex-integration.e2e.test.ts
  > Whale hooks (python) > UserPromptSubmit recall reaches the gateway and returns context
  > Whale hooks (python) > Stop capture runs without error (fire-and-forget)
  > Whale hooks (python) > SessionStart health runs without error
AssertionError: expected 2 to be +0   （进程退出码 2）
```

### 根因（已定位，未动手）

`e2e/plugins/whale-codex-integration.e2e.test.ts` 第 238-267 行的 `describe("Whale hooks (python)")` 还在用 `PYTHON` 解释器执行 **已被删除的** `whale-memory-tdai/scripts/recall.py / capture.py / health.py`（本次迁移已将 Whale hooks 从 Python 改为零依赖 Node，`git status` 里三个 `.py` 是 `D`）。Python 找不到脚本文件 → exit 2。

### 修复思路（正在进行，接手从这里开始）

参照同文件 269-307 行 `describe("Codex hooks (node)")` 的写法，把 Whale 组改为：

1. `describe` 名改 `"Whale hooks (node)"`
2. 三个用例改用 `runHook(NODE, [resolve(WHALE_DIR, "scripts/recall.js")], ...)` 等（`.py` → `.js`，`PYTHON` → `NODE`）
3. **断言契约注意**：`whale-memory-tdai/scripts/recall.js` 输出 `{ decision, additional_context }`（Whale 格式，snake_case），与 Codex 的 `hookSpecificOutput.additionalContext` 不同——现有 246-250 行断言（`out.decision === "pass"`、`out.additional_context` 含 `MEMORY_CONTEXT_FOR_QUERY`）**保持不变**即可，只换执行器和文件名
4. Whale scripts 是 ESM（`import ... from "../vendor/tdai-sdk/index.js"`），直接 `node <path>` 执行没问题（有 `#!/usr/bin/env node` 头 + package.json type）
5. 顺带检查：`PYTHON` 常量如果不再被引用，删除其定义及相关 skip 逻辑（文件 1-130 行内查找）

预期：修完后 13 项全绿。

### 否决过的思路（不要再走）

- ❌ 让 e2e 直接执行 hooks.toml 里的 command 字符串：hooks.toml 的 `node -e "..."` 是给宿主 shell 用的，e2e harness 用 spawn 数组传参更可控；清单类测试（310 行后）已覆盖 hooks.toml 内容断言
- ❌ 恢复 .py 脚本让旧测试过：Python 路线已整体放弃（外部依赖不可靠，与零依赖 Node 原则冲突）
- ❌ 改 codex-memory-tdai/hooks/hooks.json：Codex hook 经 Git Bash 展开 `${CLAUDE_PLUGIN_ROOT}` 工作正常，动了反而坏

## 5. 过程要点 / 坑（新会话必读）

- **PS 5.1 `Set-Content -Encoding utf8` 写 BOM** → codex 报 `expected value at line 1 column 1`。写 JSON 必须用 `[IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))`
- **Codex hook trust hash**：改缓存 hooks.json 后 hook 被静默跳过，需 `codex exec --dangerously-bypass-hook-trust`（`--dangerously-skip-permissions` 在 codex 不存在）
- **`whale exec` 不触发 hooks**（但会启动 MCP）；无头调用 MCP 工具需 `--dangerously-skip-permissions` 否则卡审批
- Whale plugin enable 按项目生效（`<project>/.whale/config.local.toml`）
- Whale MCP 工具经 `tool_search` 动态发现，全名 `mcp__memory_tencentdb_memory_tdai__search_memories`
- Gateway /recall 契约：`{query, session_key}`（不是 prompt/sessionId）
- e2e 断言坑：hooks.toml 头部注释含字面 `${WHALE_PLUGIN_ROOT}`，禁用模板的断言要用 `not.toMatch(/command = .*\$\{WHALE_PLUGIN_ROOT\}/)` 只查 command 行（已修）
- 沙箱限制：写 `~/.whale` / `~/.codex`、运行 whale.exe 需要提权
- 插件命令：`whale plugin install/enable/uninstall/inspect`；`codex plugin add/remove <name>@tencentdb-local`（marketplace 在 `.agents/plugins/marketplace.json`）

## 6. 收尾清单（按序执行）

- [x] 修复 e2e Whale hooks 组 3 个测试（见 §4）—— describe 改 "Whale hooks (node)"，三用例改 `runHook(NODE, [...recall/capture/health.js])`，删除 `PYTHON`/`canExec` 及未用的 `execSync`/`ChildProcess` import
- [x] `npm test`（120 绿）+ `npm run test:e2e`（13 绿）
- [x] 删除临时取证文件：`.qoder/tmp-dump-env.cjs`、`.qoder/tmp-ctx-strings.cjs`、`.qoder/tmp-var-strings.cjs`、`.qoder/tmp-emulate-whale-hook.cjs`、`.qoder/dump-*.json`（宿主侧安装缓存已通过重装恢复干净，无需处理）
- [ ] 请用户在 Whale / Codex 两个交互式会话中最终重测（用户装的插件已是修复后版本，**无需重装，重启会话即可**）
- [x] 更新记忆：宿主 `${VAR}` 展开矩阵 pitfall（已新建记忆并合并去重）
- [ ] 提交规范：`git commit -s`（DCO）、消息带 `Refs #235`；**推送到新分支/新 PR，不要推到原 `feat/codex-whale-plugins` 的 PR**（用户明确要求）
