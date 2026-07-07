# Claude Code 记忆适配器 — 实现计划

- 日期：2026-07-01
- 关联设计：[`claude-code-adapter-design.md`](./claude-code-adapter-design.md)
- 仓库：`zhexiuinori/TencentDB-Agent-Memory`（fork），建议分支 `feat/claude-code-mcp-adapter`
- 构建约定：ESM、tsdown、`bin/*.mjs`、Node≥22.16（全局 fetch）、vitest、`src/` 随包发布

每步独立可验证。验收用 `✅` 标注。

---

## 阶段 0 · 基础（架构图，必做且容易）

### Step 0.1 — 适配器文档入口
- 新建 `docs/adapters/README.md`：放设计文档里的 Mermaid 架构图 + 三路径数据流 + 三平台对照表（A/B-Python/B-MCP）。
- ✅ 验收：`docs/adapters/` 下有 README，含架构图与数据流，可独立阅读。

---

## 阶段 1 · 进阶核心（MCP 工具实现记忆读写）

### Step 1.1 — 添加 MCP SDK 依赖
- `package.json` `dependencies` 增加 `"@modelcontextprotocol/sdk": "^1.x"`（取当前稳定版）。
- `npm install` 验证可解析。
- ✅ 验收：`npm install` 无错；`import { Server } from "@modelcontextprotocol/sdk/server/index.js"` 可用。

### Step 1.2 — SDK：`src/sdk/event-binding.ts`
- 定义 `HostEventContext`、`RecallInjection`、`CaptureAck`、`ToolSchema`、`HostCompletedTurn`、`HostEventBinding`（4 方法）。
- 纯类型文件，零运行时依赖，不 import core。
- ✅ 验收：`tsc --noEmit` 通过；类型导出可被 adapter 引用。

### Step 1.3 — SDK：`src/sdk/client.ts`
- 定义 `TdaiClient` 接口（recall/capture/searchMemories/searchConversations/endSession/health）及响应类型（复用 `src/gateway/types.ts` 的字段名，但 SDK 自定义轻量类型，避免反向依赖 gateway 内部——可 import gateway types 因同包）。
- 实现 `TdaiHttpClient`：`fetch` + Bearer（`TDAI_MCP_API_KEY`→`TDAI_GATEWAY_API_KEY` 回退）+ 超时（recall 5s/capture 10s/search 5s）+ 重试（5xx 可重试 1 次）+ 错误映射（`TdaiClientError`）。
- 配置：`baseUrl`、`apiKey`、`timeoutMs` 可注入（便于测试）。
- ✅ 验收：单元测试 mock fetch 覆盖鉴权/超时/重试/错误码；`tsc --noEmit` 通过。

### Step 1.4 — SDK：`src/sdk/tool-schemas.ts`
- 导出 `MEMORY_SEARCH_SCHEMA`、`CONVERSATION_SEARCH_SCHEMA`、`CAPTURE_SCHEMA`（MCP tool schema 格式，对齐 `index.ts` 与 `client.py` 的参数定义）。
- ✅ 验收：schema 与 OpenClaw `tdai_memory_search` 工具参数一致（query/limit/type/scene）。

### Step 1.5 — Adapter 配置：`src/adapters/claude-code/config.ts`
- `ClaudeCodeAdapterConfig`：gateway baseUrl/port、apiKey 解析、userId（`TDAI_USER_ID`??`"default_user"`）、sessionKey 策略（`session_id`→回退 `cwd+日期`）。
- 从环境变量读取，带默认值。
- ✅ 验收：单元测试覆盖 env 解析与回退。

### Step 1.6 — Adapter：`src/adapters/claude-code/gateway-supervisor.ts`（v1 健康探测）
- `GatewaySupervisor`（v1）：仅 `isRunning()`（调 `client.health()`，3 次重试）+ `ensureAlive()`（探测，不拉起进程）。
- 熔断（5 失败→60s 冷却）放此处的 MCP-server 用版本；hooks 不用。
- 明确注释 v2 才加 Popen 拉起。
- ✅ 验收：单元测试 mock health 端点，覆盖 ok/degraded/超时/熔断触发。

### Step 1.7 — Adapter：`src/adapters/claude-code/claude-code-binding.ts`
- `ClaudeCodeEventBinding implements HostEventBinding`：
  - `onUserPrompt` → `client.recall()` → 返回 `RecallInjection`（`<relevant-memories>` 包裹）。
  - `onTurnEnd` → `client.capture()` → 返回 `CaptureAck`。
  - `onSessionEnd` → `client.endSession()`。
  - `getToolSchemas()` → 返回 tool-schemas。
- 注入 `TdaiClient` + `ClaudeCodeAdapterConfig`。
- ✅ 验收：单元测试 mock client，验证 4 方法的调用参数与返回结构。

### Step 1.8 — Adapter：`src/adapters/claude-code/mcp-server.ts`
- 用 `@modelcontextprotocol/sdk` 创建 stdio MCP server。
- 注册工具：`tdai_memory_search`、`tdai_conversation_search`、`tdai_capture`（每个工具 `execute` → 调 `binding` 对应方法或直接 `client`）。
- 启动时 `supervisor.ensureAlive()` 探测；不阻塞失败。
- 工具失败返回错误文本，不抛。
- ✅ 验收：可用 `npx tsx src/adapters/claude-code/mcp-server.ts` 启动；MCP inspector 能列出 3 个工具并调用（手动）。

### Step 1.9 — Adapter barrel + 导出
- `src/adapters/claude-code/index.ts`：barrel 导出 binding/supervisor/config。
- `src/adapters/index.ts`：追加 `export { ClaudeCodeEventBinding } from "./claude-code/index.js"` 等。
- ✅ 验收：`tsc --noEmit` 通过；从 `src/adapters` 可导入。

### Step 1.10 — 构建/bin 接入
- 检查 `tsdown.config.ts`，按需把 mcp-server 加入构建入口（或单独 `tsc` 到 `bin/`）。
- 新增 `bin/memory-tdai-mcp.mjs`（仿现有 bin 模式），指向构建产物。
- `package.json` `bin` 追加 `"memory-tdai-mcp": "./bin/memory-tdai-mcp.mjs"`。
- ✅ 验收：`npm run build` 通过；`memory-tdai-mcp` 可执行启动 MCP server。

### Step 1.11 — 配置模板
- `src/adapters/claude-code/config/mcp.json.example`：注册 MCP server（command/args/env）。
- `src/adapters/claude-code/config/settings.json.example`：hooks 占位（深入阶段实装；此阶段先放注释模板）。
- ✅ 验收：模板可被复制为 `.mcp.json` 并被 Claude Code 识别。

### Step 1.12 — 测试：单元 + 集成
- 单元：`src/sdk/client.test.ts`、`src/adapters/claude-code/claude-code-binding.test.ts`、`config.test.ts`、`gateway-supervisor.test.ts`。
- 集成：`src/adapters/claude-code/integration.test.ts`——起 Gateway（SQLite）于随机端口，用真实 `TdaiHttpClient` 走 recall→capture→search 闭环。
- ✅ 验收：`npm test` 全绿；集成测试覆盖三路径。

### Step 1.13 — README
- `src/adapters/claude-code/README.md`：前置条件（启 Gateway）、安装、`.mcp.json` 配置、工具说明、手动验收清单（跨会话记忆持久化）、已验证 Claude Code 版本。
- ✅ 验收：按 README 可在真实 Claude Code 中跑通 search/capture。

> **阶段 1 完成 = 进阶验收达标。**

---

## 阶段 2 · 深入（钩子 + Codex + 对比文档）

### Step 2.1 — hooks：`src/adapters/claude-code/hooks/`
- `recall.ts`：读 Claude Code `UserPromptSubmit` stdin JSON → `client.recall()` → 输出 `{additionalContext}` JSON，退出码 0，全程 try/catch。
- `capture.ts`：读 `Stop` stdin JSON（transcript）→ 提取 user/assistant → `client.capture()`。
- `session-end.ts`：`SessionEnd` → `client.endSession()`。
- 每个钩子可独立 `npx tsx` 调用。
- ✅ 验收：钩子契约测试——喂样例 stdin，断言 Gateway 调用 + 输出 JSON 合法 + 退出码 0；真实 Claude Code 会话验证 auto-recall/capture。

### Step 2.2 — Codex 验证
- 用同一 MCP server 在 Codex 中配置（Codex MCP 配置），验证 `tdai_memory_search`/`capture` 可用。
- 记录 Codex 配置差异到 README/对比文档。
- ✅ 验收：Codex 能调用记忆工具并读写同一 Gateway。

### Step 2.3 — 对比文档
- `docs/adapters/platform-comparison.md`：Pattern A（OpenClaw 进程内）vs Pattern B-Python（Hermes）vs Pattern B-MCP（Claude Code/Codex）。维度：引擎位置/传输/事件绑定/生命周期/鉴权/优缺点/适用场景。
- ✅ 验收：文档含三平台对照表 + 选型建议。

> **阶段 2 完成 = 深入验收达标。**

---

## 阶段 3 · 拓展（统一 SDK，冲刺）

### Step 3.1 — 析出 `src/sdk/lifecycle.ts`
- 把 `gateway-supervisor.ts` 的熔断/健康探测/（v2）Popen 拉起抽成通用 `GatewayLifecycleManager`，Claude Code 改为消费它。
- ✅ 验收：Claude Code supervisor 变薄，逻辑迁入 `src/sdk/lifecycle.ts`；测试迁移且绿。

### Step 3.2 — 第二平台：Dify EventBinding
- 在 `dify-plugin/`（新建）下用 Python 实现一个最小 `DifyEventBinding`（映射 Dify 事件→`client.py` 调用），复用现有 `hermes-plugin/.../client.py`。
- ✅ 验收：Dify 插件能通过 `client.py` 调用 Gateway 实现 recall/capture（至少 demo 级）。

### Step 3.3 — SDK README
- `src/sdk/README.md`：Track 1（进程内 JS，实现 `HostAdapter`）vs Track 2（进程外，实现 `HostEventBinding` + 选 `TdaiClient`）两条路径；「新平台接入只需实现一个接口」的最小示例。
- ✅ 验收：按 README 可为一个新宿主写出 EventBinding 骨架。

> **阶段 3 完成 = 拓展验收达标。**

---

## 执行顺序与依赖

```
0.1 → 1.1 → 1.2 → 1.3 → 1.4 → 1.5 → 1.6 → 1.7 → 1.8 → 1.9 → 1.10 → 1.11 → 1.12 → 1.13  (进阶)
                                                                        ↓
                                                              2.1 → 2.2 → 2.3  (深入)
                                                                        ↓
                                                              3.1 → 3.2 → 3.3  (拓展)
```

每步完成后跑 `tsc --noEmit` + 相关测试。阶段 1 结束先停下确认再进阶段 2。
