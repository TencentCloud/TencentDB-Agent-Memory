# Trae 记忆适配器 + 薄统一适配层 — 设计文档

- **日期**:2026-07-21
- **关联 issue**:[#235](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/235) Cross-Platform Adapters for the Memory Plugin(犀牛鸟中高难度)
- **分支**:`feat/issue-235-platform-adapter`(基于 `main`)
- **实现语言**:TypeScript
- **状态**:设计稿,待用户复审 → 转 writing-plans 出实现计划

---

## 1. 背景与目标

issue #235 要求把核心记忆引擎 `TdaiCore` 接入更多 Agent 平台。当前已适配:OpenClaw(进程内)、Hermes(HTTP sidecar);进行中的同类 PR:#316(HTTP baseline)/ #372(MCP 桥)/ #516(Codex)/ #517(Claude Code)/ #394(Dify)/ #339(大统一 SDK,争议中)。

本方案三大目标:

1. **接入一个未被占用的平台 Trae**(字节系 AI IDE),实现基本记忆读写;
2. **整合现有 PR 的优势**而非再造一份:复用 #316 的 HTTP client、移植 #517 的 hooks reliability、瘦身 #339 的 ABC 内核;
3. **完整覆盖 issue 验收并差异化**:稳拿进阶、用「Trae + 对比现有平台」达成深入、薄整合层作为拓展雏形。

差异化卖点(相对 Mem0/Zep/Letta/Hindsight):Trae 完全未被占用 + 整合碎片化 client + 腾讯云底座/中国合规 + FTS5+NFKC 召回质量。

---

## 2. 现状分析(为什么这么定位)

### 2.1 平台选型 — 为什么是 Trae

6 个候选里 3 个已「变天」:Continue(2025-07 被 Cursor 收购停服)、Roo Code(2026-05 关闭)、Windsurf(改名 Devin Desktop,砍记忆 + Rust 重写,进程内路径架构不可能)。健康候选只剩 **Trae / Cursor / Cline**。

- Cursor 是红海(Mem0 官方三件套 MCP+Hooks+Skill 已占心智)。
- **Trae 完全未被占用**(Mem0/Letta/Zep 无官方适配),且它的 hooks 事件(`SessionStart` / `UserPromptSubmit` / `Stop`)与 `TdaiCore` API **一一对应**,还内置「导入 Claude Code hooks」开关 —— 意味着 #517 的 hooks 脚本可近乎直接迁移。MCP v1.3.0+ 一等公民(stdio/SSE/Streamable HTTP 全支持)。

### 2.2 现有 PR 的碎片化(整合机会)

HTTP Gateway client 当前有 **4 份自写**:#316 `GatewayMemoryClient`、#372 `TdaiGatewayClient`、#517 `src/adapters/claude-code/gateway-client.ts`、#394 `dify-plugin-tdai-memory/tools/client.py`。#316 已被 maintainer `YOMXXX` 认可为 lightweight baseline。**整合机会:新平台复用 #316,做「正确整合」的范例,不再造第 5 份。**

### 2.3 Approach 定位 — 与现有 PR 不冲突

| 现有 PR | 关系 |
|---|---|
| #316 HTTP baseline | **复用** `GatewayMemoryClient` / `createGatewayPlatformAdapter` |
| #372 MCP 桥 | **复用**其 MCP server 模式(纯 JSON-RPC、closed schema) |
| #339 大 SDK | **只取 ABC 内核**(retry/recall 缓存/降级),瘦身 15K→~1.5K 行 |
| `core` 的 `hostType` union | **不碰**(走 HTTP 路径,零 core 改动,最易合并) |

### 2.4 「深入」的落地解读

issue「深入」要求「2+ 平台 + 对比文档」。本方案解读为:**Trae 自己实现(1 个平台)+ 对比文档对比已有 5 个平台**(OpenClaw / Hermes / Codex#516 / Claude Code#517 / Dify#394)。既满足「深入」的对比分析要求,又不必自己实现第二个平台(避免与 Cline 等潜在贡献者撞车)。若后续要自实现第二平台(如 Cline),可在此基础上扩展。

---

## 3. 架构

三层,Trae 平台层 → 薄整合层 → #316 client → Gateway → TdaiCore:

```
┌─ Trae 平台层 ───────────────────────────────────────┐
│ trae-plugin/.trae/hooks.json   ← 复用 #517 hook 逻辑 │
│ trae-plugin/.trae/mcp.json     ← 指向 MCP server    │
│ trae-plugin/scripts/memory-hook.mjs                  │
└──────────────┬──────────────────────────────────────┘
        stdin JSON hooks        MCP stdio
┌──────────────▼──────────────────────────────────────┐
│ 薄整合层  src/adapters/tdai-bridge/                  │  ← 整合卖点
│  TdaiBridge(concrete class)                          │
│  包 GatewayMemoryClient + 分类 retry + recall 缓存   │
│  + 输入消毒 + 优雅降级                                │
└──────────────┬──────────────────────────────────────┘
                      HTTP(7 端点)
┌──────────────▼──────────────────────────────────────┐
│ #316 GatewayMemoryClient → TdaiGateway → TdaiCore    │  ← 复用基座
└─────────────────────────────────────────────────────┘
```

---

## 4. 组件设计

### 4.1 薄整合层 `TdaiBridge`(src/adapters/tdai-bridge/)

**定位**:#316 `GatewayMemoryClient` 之上的一层 reliability 包装,被 Trae 的 hooks 和 MCP 两条腿共用,提供统一的 retry / recall 缓存 / 输入消毒 / 优雅降级。

**为什么是 concrete class 而非 abstract**(`ponytail: single HTTP backend → no abstract yet`):Trae 只走 HTTP 一种后端,搞 `abstract class` + 单子类是「interface with one implementation」反模式。`TdaiBridge` 做成具体类,直接包 client;**未来真出现非 HTTP 后端(如进程内直调 TdaiCore)再抽 abstract**。

**接口契约**(TS,示意):

```ts
import { GatewayMemoryClient } from "../gateway-client/index.js"; // #316

export class TdaiBridge {
  constructor(client: GatewayMemoryClient, opts?: BridgeOpts);

  // 模板方法(public):每个都做 sanitize → retry → (recall 走缓存) → 降级
  recall(query: string, sessionKey: string): Promise<RecallResponse>;
  capture(turn: { userText: string; assistantText: string }, sessionKey: string): Promise<CaptureResponse>;
  searchMemory(query: string, opts?: SearchOpts): Promise<MemorySearchResponse>;
  searchConversation(query: string, opts?: SearchOpts): Promise<ConversationSearchResponse>;
  endSession(sessionKey: string): Promise<SessionEndResponse>;
}
```

**从 #339 保留(高杠杆、低依赖)**:
- 分类 retry:指数退避 + jitter,只对瞬态错误(Connection/Timeout/RateLimit)重试,不重试 Validation/Auth;
- **recall 会话缓存**:SHA-256(query) 作 key,同会话同查询命中即返回 —— 直接修 #120(prompt-cache 杀手);
- 输入消毒:query 截断、limit clamp,防下游 OOM/慢查询;
- 优雅降级:任何异常 `warn` 后返回安全空值(`""`/空结果),绝不向 hooks/MCP 层抛。

**从 #339 砍掉(YAGNI / 属于其他 PR)**:G2 限流 / G3 熔断 / G4 审计(桌面 loopback 用不到)、BufferedAdapter(零用户)、HermesV2Adapter、TS/Python 双语言、mcp_health 双进程、OTel/L2/编码等基础设施修复(应拆独立 PR)。

### 4.2 Trae 适配层(src/adapters/trae/ + trae-plugin/)

两条腿,都消费 `TdaiBridge`:

**腿 ① Hooks**(主要 recall/capture 触发点,自动):
- `trae-plugin/.trae/hooks.json`:声明 Trae 生命周期 hook → 指向 `memory-hook.mjs`;
- `trae-plugin/scripts/memory-hook.mjs`:Node 入口,读 stdin JSON,调 `hook-handler`;
- `src/adapters/trae/hook-handler.ts`:**复用 #517 的 hook-handler 逻辑**,适配 Trae 事件:
  - `SessionStart` → `bridge.recall()` 预热;
  - `UserPromptSubmit`(读 prompt)→ `bridge.recall()` + 输出有界 `additionalContext`;
  - `Stop`(含 `last_assistant_message`)→ `bridge.capture()`;
  - `SessionEnd` → `bridge.endSession()`;
- 移植 #517 reliability:持久化重试队列(`${TRAE_PLUGIN_DATA}`)、有界 `additionalContext` 注入、SessionEnd 短超时预算。

**腿 ② MCP server**(search 触发点,模型按需):
- `src/adapters/trae/mcp-server.ts`:**复用 #372 的 MCP server 模式**(纯 JSON-RPC、closed schema、G0 校验 + G1 HMAC),5 个 tools:`tdai_recall` / `tdai_capture` / `tdai_memory_search` / `tdai_conversation_search` / `tdai_session_end`;
- tools 调 `TdaiBridge`(而非裸 client),统一拿 retry/缓存/降级;
- `trae-plugin/.trae/mcp.json`:指向 server bin。

> Trae 内置「导入 Claude Code hooks」开关,#517 的 hook 协议(stdin JSON + `additionalContext`)可直接复用,这是选 Trae 的关键整合抓手。

### 4.3 对比文档(docs/platform-adapters-comparison.md)

满足「深入」对比要求。对比 6 个平台 × 6 维度:

| 平台 | 接入模式 | 改 core? | HTTP client | L0 读写 | reliability | MCP |
|---|---|---|---|---|---|---|

(OpenClaw / Hermes / Codex / Claude Code / Dify / **Trae**)

配 3 张 Mermaid:① 组件架构、② 召回读路径、③ L0→L3 写路径。对齐 #515 的图示风格。

### 4.4 测试

- `TdaiBridge` 单元:retry 各分支(瞬态重试 / Auth 不重试)、recall 缓存命中/失效、输入消毒边界、优雅降级;
- `hook-handler`:各 Trae 事件 stdin JSON → 正确 bridge 调用 + additionalContext 输出;
- `mcp-server`:复用 #372 的 lifecycle / tools/call / 校验测试模式;
- 集成:mock Gateway(HTTP interceptor)验证端到端 recall/capture。

---

## 5. 文件落点

```
src/adapters/tdai-bridge/
  tdai-bridge.ts              # concrete TdaiBridge(client + retry/缓存/降级/消毒)
  tdai-bridge.test.ts
src/adapters/trae/
  hook-handler.ts             # 复用 #517 逻辑,适配 Trae 事件
  hook-handler.test.ts
  mcp-server.ts               # 复用 #372 模式,tools 调 TdaiBridge
  mcp-server.test.ts
  index.ts
trae-plugin/
  .trae/hooks.json
  .trae/mcp.json
  scripts/memory-hook.mjs     # Node 入口
  README.md
docs/
  trae-adapter.md             # Trae 适配指南(交付)
  platform-adapters-comparison.md  # 6 平台对比(深入交付)
src/adapters/index.ts         # 追加导出
index.ts                      # 追加导出(按需)
package.json / tsdown.config.ts  # 注册 mcp bin + bundle
```

---

## 6. 范围边界

**做**:① 薄整合层 `TdaiBridge`;② Trae hooks + MCP;③ 6 平台对比文档;④ 测试。

**不做(YAGNI)**:
- 不改 `core` 的 `hostType` union(走 HTTP);
- 不自写 HTTP client(复用 #316);
- 不做 G2/G3/G4 防御门(BufferedAdapter 同理);
- 不做 Python 版 / TS·Py 双语言;
- 不自己实现第二平台(Cline 等),对比文档以现有 PR 为对象。

---

## 7. 验收映射

| issue 阶段 | 标准 | 落点 |
|---|---|---|
| 基础 | 架构图 + 数据流 | 对比文档 3 张 Mermaid |
| 进阶 | 1 平台基本读写 | Trae hooks + MCP |
| 深入 | 2+ 平台 + 对比 | Trae + 对比 5 个现有平台 |
| 拓展 | 统一适配 SDK | `TdaiBridge` 薄整合层(雏形) |

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| #316 / #372 尚未 merge | PR 策略三选一(实现期定):基于 #316 分支 / vendoring client 并注明 / 等 merge。设计层不锁死 |
| Trae hooks stdin 协议细节 | 实现阶段实测 Trae hooks(用「导入 Claude Code hooks」开关验证字段),hook-handler 做字段兼容 |
| 与 #517 / #372 边界 | 只新增文件,不改它们;复用通过 import(若已 merge)或 vendoring |
| 触 #339 雷区 | PR 描述主动说明:「定位 #316 之上、瘦身 #339、回应 YOMXXX 拆分诉求」,正面对齐 maintainer 意图 |
| Trae 闭源 AI 生命周期 | 不走进程内路径 A,只走 MCP + 外部 hooks(路径 B/C),规避闭源限制 |

---

## 9. 复用清单(整合卖点的具体来源)

- **#316** `GatewayMemoryClient` + `createGatewayPlatformAdapter` → HTTP 基座
- **#517** hook-handler 的 reliability 模式(持久化重试队列 / 有界注入 / SessionEnd 短超时)→ 移植到 Trae hooks
- **#372** MCP server 模式(纯 JSON-RPC / closed schema / G0+G1)+ `buildGatewayRecallResponse` → 复用
- **#339** ABC 内核(分类 retry / recall 缓存修 #120 / 优雅降级 / 输入消毒)→ 瘦身进 `TdaiBridge`

---

## 10. 后续

本 spec 经用户复审后,转 `writing-plans` skill 产出分步实现计划(TDD 粒度),再进入实现。
