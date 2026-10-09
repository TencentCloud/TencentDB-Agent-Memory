# 任务完成报告：多平台适配层接入

> 任务：为 TencentDB Agent Memory 核心引擎新增 Agent 平台适配，并沉淀统一接入方案。
> 交付日期：见 git 提交记录。所有产物位于 `adapter-sdk/` 与 `docs/adapters/`，未改动核心引擎。

---

## 1. 任务目标回顾

核心记忆引擎已支持 OpenClaw（插件）与 Hermes（Provider）两种接入。本任务要求：

1. 阅读核心引擎接口，理解 `TdaiCore` 能力边界；
2. 分析已有两种适配方式的异同；
3. 为一个新平台编写适配层，实现记忆读写；
4. 编写适配文档，沉淀接入最佳实践。

四级渐进式验收：基础（架构图）→ 进阶（单平台读写）→ 深入（多平台 + 对比）→ 拓展（统一 SDK）。

**结论：四级全部达成。**

---

## 2. 交付物清单

### 2.1 代码

| 路径 | 说明 |
| :-- | :-- |
| `adapter-sdk/src/types.ts` | 唯一对外接口 `PlatformBinding` + 归一化输入/输出类型 |
| `adapter-sdk/src/gateway-client.ts` | Gateway REST 客户端（Node 内置 `fetch`，零依赖） |
| `adapter-sdk/src/adapter-core.ts` | `MemoryAdapter` 通用编排（召回/捕获/flush/工具） |
| `adapter-sdk/src/config.ts` | 环境变量解析（Gateway 地址/密钥/用户） |
| `adapter-sdk/src/index.ts` | 出口 barrel + `createAdapterFromEnv()` |
| `adapter-sdk/src/adapter-sdk.test.ts` | 13 个 vitest 单测（mock fetch） |
| `adapter-sdk/bindings/claude-code/binding.ts` | Claude Code 绑定：解析 hook JSON + transcript |
| `adapter-sdk/bindings/claude-code/hook-cli.ts` | Hooks 统一入口：`recall`/`capture`/`session-end` |
| `adapter-sdk/bindings/claude-code/mcp-server.ts` | 无依赖 MCP stdio 服务（暴露两个记忆工具） |
| `adapter-sdk/bindings/claude-code/install.sh` | 幂等安装脚本（写入 hooks 与 MCP 配置） |
| `adapter-sdk/bindings/claude-code/*.example.json` | 手动配置示例 |
| `adapter-sdk/bindings/codex/binding.ts` + `notify.ts` | 极简第二绑定，证明「一个接口即可接入」 |

### 2.2 文档

| 路径 | 对应验收 |
| :-- | :-- |
| `docs/adapters/ARCHITECTURE.md` | 基础：架构图 + 数据流 + REST 契约 |
| `docs/adapters/claude-code.md` | 进阶：Claude Code 安装与使用 |
| `docs/adapters/comparison.md` | 深入：三平台差异对比 |
| `docs/adapters/adapter-sdk.md` | 拓展：统一 SDK 指南 + 新平台三步接入 |
| `adapter-sdk/README.md` 及各 binding README | 目录导航 |

---

## 3. 对核心引擎的理解（任务 1）

`TdaiCore`（`src/core/tdai-core.ts`）是所有平台共享的唯一入口，**仅依赖两个抽象**（`HostAdapter`、`LLMRunnerFactory`），暴露 5 个宿主中立能力：

| 方法 | 语义 |
| :-- | :-- |
| `handleBeforeRecall(userText, sessionKey)` | turn 前召回相关记忆 |
| `handleTurnCommitted(turn)` | 捕获对话，写 L0 并触发 L1/L2/L3 流水线 |
| `searchMemories(params)` | L1 结构化记忆检索 |
| `searchConversations(params)` | L0 原始对话检索 |
| `handleSessionEnd(sessionKey)` | **单会话** flush（区别于整进程 `destroy()`） |

关键洞察：**核心与宿主完全解耦**，任何平台只需把生命周期事件翻译成这 5 个调用。

---

## 4. 已有适配方式异同分析（任务 2）

| 维度 | OpenClaw 插件 | Hermes Provider |
| :-- | :-- | :-- |
| 通信 | 进程内直连 `TdaiCore` | HTTP → Gateway → `TdaiCore` |
| LLM | 复用宿主 runtime | 独立 OpenAI 兼容 HTTP |
| 召回/捕获接入 | `before_prompt_build` / `agent_end` 钩子 | `prefetch()` / `sync_turn()` |
| 工具 | `api.registerTool` | `get_tool_schemas` + `handle_tool_call` |
| 健壮性 | 宿主托管 | 熔断器 + 看门狗 + 后台线程 + 自动拉起 |

共同点：都最终落到同一 `TdaiCore`；HTTP 路线共享稳定的 Gateway REST 契约——这正是抽象统一 SDK 的基础。完整对比见 `docs/adapters/comparison.md`。

---

## 5. 新平台适配：Claude Code（任务 3）

复用与 Hermes 相同的 HTTP Gateway，通过 Claude Code 原生扩展机制接入：

| Claude Code 事件 | 归一化操作 | Gateway |
| :-- | :-- | :-- |
| `UserPromptSubmit` | 召回并注入 `additionalContext` | `POST /recall` |
| `Stop` | 解析 `transcript_path` 取最后一轮后捕获 | `POST /capture` |
| `SessionEnd` | 会话 flush | `POST /session/end` |
| MCP `tools/call` | `memory_search` / `conversation_search` | `POST /search/*` |

难点处理：`Stop` 事件不含对话正文，适配层解析 transcript JSONL 反推最后一轮（`readLastTurn`）。

---

## 6. 拓展：统一适配器 SDK（任务 4）

抽出可复用的传输 + 编排层，新平台只需实现一个 `PlatformBinding`：

```
平台原生事件 ──parse──▶ 归一化输入 ──▶ Gateway REST
Gateway 结果 ──format──▶ 平台原生输出
```

三步接入：
1. 实现 `PlatformBinding`（parse/format）；
2. `createAdapterFromEnv(binding)`；
3. 在平台事件入口调 `adapter.handle{Recall,Capture,SessionEnd,ToolCall}`。

`Codex` 绑定（几十行）与 `ClaudeCode` 绑定（含 transcript 解析）对比，直观印证「边际成本仅剩平台专属翻译」。

---

## 7. 验证结果

| 项目 | 命令 | 结果 |
| :-- | :-- | :-- |
| 类型检查 | `tsc -p adapter-sdk/tsconfig.json` | 通过（src + bindings 全量，0 错误） |
| 单元测试 | `vitest run adapter-sdk/src/adapter-sdk.test.ts` | 13/13 通过 |
| 端到端冒烟 | 假 Gateway + hook-cli + mcp-server | recall/capture/session-end/MCP 全部正确 |

冒烟实测输出（节选）：
- recall → 正确产出含 `additionalContext` 的 hook JSON；
- capture → 正确从 transcript 提取 user/assistant 并写入 Gateway；
- MCP → `initialize`/`tools/list`/`tools/call` 响应符合协议。

---

## 8. 设计原则

- **绝不打断宿主**：hook 任何异常 `exit(0)`，`MemoryAdapter` 吞掉所有 Gateway 错误。
- **零运行时依赖**：仅 Node 内置能力；MCP 手写 stdio JSON-RPC。
- **零核心侵入**：未改动 `src/core` 与既有适配层，纯增量交付。
- **约定对齐**：环境变量与 Hermes 一致，可与现有 Gateway 共用同一记忆库。

---

## 9. 后续可拓展方向

- 将 `memory_search`/`conversation_search` 之外的能力（如 seed 批量导入）纳入 SDK；
- 为 Dify 等编排平台补充 binding；
- 探索 Claude Code 短期符号压缩（offload）接入。
