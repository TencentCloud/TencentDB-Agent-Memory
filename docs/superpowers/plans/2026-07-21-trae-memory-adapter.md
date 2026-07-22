# Trae Memory Adapter + Thin Bridge Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 TencentDB-Agent-Memory 接入 Trae 平台(记忆读写),并新增一层薄整合 `TdaiBridge`(复用 #316 client,移植 #517 reliability、#372 MCP、#339 retry/缓存/降级)。

**Architecture:** 三层 —— Trae 平台层(hooks + MCP)→ `TdaiBridge` 薄整合层 → #316 `GatewayMemoryClient` → `TdaiGateway` → `TdaiCore`。零 core 改动。

**Tech Stack:** TypeScript、Node 原生 `http`(无 Express)、MCP JSON-RPC over stdio、vitest。

## Global Constraints

- **语言 TypeScript**;Node 原生 `http`,不引入 Express/Fastify。
- **不改 `core` 的 `hostType` union**(走 HTTP 路径)。
- **不自写 HTTP client**:复用 #316 `GatewayMemoryClient`;若 #316 未 merge,vendoring 其 `src/adapters/gateway-client/index.ts` 并在文件头注明来源。
- **不做** G2/G3/G4 防御门、BufferedAdapter、HermesV2Adapter、Python 版、OTel/L2/编码修复(属其他 PR)。
- **commit 需用户明确同意,不自动提交**(遵循项目 CLAUDE.md)。计划中 commit 步骤为 checkpoint,执行时征求确认。
- 代码注释语言跟随仓库现有风格(中英混合,以现有 `src/adapters/` 文件为准)。
- TDD:每个功能先写失败测试,再实现。

---

## File Structure(锁定分解)

| 文件 | 职责 | 来源 |
|---|---|---|
| `src/adapters/tdai-bridge/tdai-bridge.ts` | concrete `TdaiBridge`:包 client + retry + recall 缓存 + 消毒 + 降级 | 新(取 #339 内核) |
| `src/adapters/tdai-bridge/tdai-bridge.test.ts` | retry/cache/sanitize/degrade 单测 | 新 |
| `src/adapters/trae/hook-handler.ts` | Trae 事件 → TdaiBridge(stdin JSON→recall/capture/additionalContext) | 新(复用 #517 逻辑) |
| `src/adapters/trae/hook-handler.test.ts` | 各事件单测 | 新 |
| `src/adapters/trae/mcp-server.ts` | MCP server,5 tools 调 TdaiBridge | 新(参照 #372 模式) |
| `src/adapters/trae/mcp-server.test.ts` | lifecycle/tools/校验单测 | 新 |
| `src/adapters/trae/index.ts` | barrel 导出 | 新 |
| `trae-plugin/.trae/hooks.json` | Trae hooks 配置 | 新 |
| `trae-plugin/.trae/mcp.json` | Trae MCP 配置 | 新 |
| `trae-plugin/scripts/memory-hook.mjs` | Node 入口,调 hook-handler | 新 |
| `trae-plugin/README.md` | 安装/配置说明 | 新 |
| `docs/platform-adapters-comparison.md` | 6 平台对比 + 3 Mermaid | 新(深入交付) |
| `docs/trae-adapter.md` | Trae 适配指南 | 新 |
| `src/adapters/index.ts` / `index.ts` | 追加导出 | 改 |

---

## Task 1: 复用基座 + `TdaiBridge` 薄整合层

**Files:**
- Create: `src/adapters/tdai-bridge/tdai-bridge.ts`
- Create: `src/adapters/tdai-bridge/tdai-bridge.test.ts`
- (基座)若 main 无 `src/adapters/gateway-client/`:vendoring #316 的 `index.ts`,文件头加 `// vendored from PR #316 (GatewayMemoryClient); track upstream for updates`

**Interfaces:**
- Consumes: #316 `GatewayMemoryClient`(methods: `recall`/`capture`/`searchMemories`/`searchConversations`/`endSession`/`health`),`GatewayMemoryClientError { status, path, responseBody }`
- Produces: `class TdaiBridge`,methods: `recall(query, sessionKey)`、`capture(turn, sessionKey)`、`searchMemory(query, opts?)`、`searchConversation(query, opts?)`、`endSession(sessionKey)`;构造 `new TdaiBridge(client, opts?)`

- [ ] **Step 1: 确认基座可用性**

Run: `git ls-files src/adapters/gateway-client/ | head`
- 若有输出(import 路径稳定):记录为 import 模式。
- 若空(#316 未 merge):从 PR #316 拉 `src/adapters/gateway-client/index.ts` 到本地同路径,文件头加 vendoring 注释。Run: `curl -sS https://raw.githubusercontent.com/TencentCloud/TencentDB-Agent-Memory/refs/heads/<pr316-head>/src/adapters/gateway-client/index.ts -o src/adapters/gateway-client/index.ts`(head 分支名见 PR #316)。

- [ ] **Step 2: 写失败测试 — retry 只对瞬态错误重试**

```ts
// src/adapters/tdai-bridge/tdai-bridge.test.ts
import { describe, it, expect, vi } from "vitest";
import { TdaiBridge } from "./tdai-bridge.js";
import { GatewayMemoryClientError } from "../gateway-client/index.js";

function makeClient(overrides: Partial<GatewayMemoryClient> = {}) {
  return {
    recall: vi.fn(),
    capture: vi.fn(),
    searchMemories: vi.fn(),
    searchConversations: vi.fn(),
    endSession: vi.fn(),
    health: vi.fn(),
    ...overrides,
  } as unknown as GatewayMemoryClient;
}

describe("TdaiBridge retry", () => {
  it("retries transient (status 503) then succeeds", async () => {
    const client = makeClient({
      recall: vi.fn()
        .mockRejectedValueOnce(new GatewayMemoryClientError("/recall", 503, "busy"))
        .mockResolvedValueOnce({ context: "OK" } as any),
    });
    const bridge = new TdaiBridge(client, { retry: { attempts: 3, baseMs: 1 } });
    const res = await bridge.recall("hello", "sess-1");
    expect(client.recall).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ context: "OK" });
  });

  it("does NOT retry auth errors (status 401)", async () => {
    const client = makeClient({
      recall: vi.fn().mockRejectedValue(new GatewayMemoryClientError("/recall", 401, "no key")),
    });
    const bridge = new TdaiBridge(client, { retry: { attempts: 3, baseMs: 1 } });
    // 降级:recall 失败返回空串,不抛
    const res = await bridge.recall("hello", "sess-1");
    expect(client.recall).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ context: "" });
  });
});
```

- [ ] **Step 3: 运行测试,确认失败**

Run: `npx vitest run src/adapters/tdai-bridge/tdai-bridge.test.ts`
Expected: FAIL(`TdaiBridge` 未定义 / import 失败)

- [ ] **Step 4: 实现 `TdaiBridge`(最小通过 + retry/降级)**

```ts
// src/adapters/tdai-bridge/tdai-bridge.ts
import type { GatewayMemoryClient } from "../gateway-client/index.js";
import { GatewayMemoryClientError } from "../gateway-client/index.js";

export interface BridgeRetryOpts { attempts: number; baseMs: number; }
export interface BridgeOpts {
  retry?: Partial<BridgeRetryOpts>;
  recallCacheMax?: number; // ponytail: Map cap,默认 256
}

const DEFAULT_RETRY: BridgeRetryOpts = { attempts: 3, baseMs: 200 };

// ponytail: 仅瞬态错误重试;Auth/Validation 立即降级
function isTransient(err: unknown): boolean {
  if (err instanceof GatewayMemoryClientError) {
    return err.status === 408 || err.status === 425 || err.status === 429 || err.status >= 500;
  }
  return err instanceof TypeError || err instanceof Error && /fetch|network|timeout/i.test(err.message);
}

async function withRetry<T>(fn: () => Promise<T>, opts: BridgeRetryOpts): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (!isTransient(err)) throw err; // 非瞬态:上抛(由模板方法降级)
      const delay = opts.baseMs * 2 ** attempt + Math.random() * opts.baseMs;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export class TdaiBridge {
  private readonly retry: BridgeRetryOpts;
  private readonly cache = new Map<string, unknown>(); // ponytail: SHA-256 key,修 #120
  private readonly cacheMax: number;

  constructor(private readonly client: GatewayMemoryClient, opts: BridgeOpts = {}) {
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
    this.cacheMax = opts.recallCacheMax ?? 256;
  }

  async recall(query: string, sessionKey: string): Promise<{ context: string }> {
    const q = sanitize(query, 100_000);
    const key = sessionKey + ":" + q;
    if (this.cache.has(key)) return this.cache.get(key) as { context: string };
    try {
      const res = await withRetry(() => this.client.recall({ query: q, session_key: sessionKey } as any), this.retry);
      this.cache.set(key, res);
      if (this.cache.size > this.cacheMax) this.cache.clear(); // ponytail: 简单容量治理;LRU 若命中率不够再换
      return res as { context: string };
    } catch (err) {
      console.warn("[tdai-bridge] recall degraded:", (err as Error).message);
      return { context: "" }; // 优雅降级:永不抛
    }
  }

  async capture(turn: { userText: string; assistantText: string }, sessionKey: string): Promise<{ ok: boolean }> {
    try {
      await withRetry(() => this.client.capture({
        user_text: sanitize(turn.userText, 1_000_000),
        assistant_text: sanitize(turn.assistantText, 1_000_000),
        session_key: sessionKey,
      } as any), this.retry);
      return { ok: true };
    } catch (err) {
      console.warn("[tdai-bridge] capture degraded:", (err as Error).message);
      return { ok: false };
    }
  }

  async searchMemory(query: string, opts: { limit?: number } = {}): Promise<unknown> {
    try {
      return await withRetry(() => this.client.searchMemories({
        query: sanitize(query, 100_000), limit: clamp(opts.limit ?? 10, 1, 50),
      } as any), this.retry);
    } catch (err) { console.warn("[tdai-bridge] search degraded:", (err as Error).message); return []; }
  }

  async searchConversation(query: string, opts: { limit?: number } = {}): Promise<unknown> {
    try {
      return await withRetry(() => this.client.searchConversations({
        query: sanitize(query, 100_000), limit: clamp(opts.limit ?? 10, 1, 50),
      } as any), this.retry);
    } catch (err) { console.warn("[tdai-bridge] search degraded:", (err as Error).message); return []; }
  }

  async endSession(sessionKey: string): Promise<void> {
    try { await this.client.endSession({ session_key: sessionKey } as any); }
    catch (err) { console.warn("[tdai-bridge] endSession degraded:", (err as Error).message); }
  }
}

function sanitize(s: string, max: number): string { return s.length > max ? s.slice(0, max) : s; }
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }
```

- [ ] **Step 5: 运行测试,确认通过**

Run: `npx vitest run src/adapters/tdai-bridge/tdai-bridge.test.ts`
Expected: PASS(2/2)

- [ ] **Step 6: 补 cache + sanitize 测试**

追加:
```ts
describe("TdaiBridge cache & sanitize", () => {
  it("recall 同会话同查询命中缓存(只调一次 client)", async () => {
    const client = makeClient({ recall: vi.fn().mockResolvedValue({ context: "X" } as any) });
    const bridge = new TdaiBridge(client, { retry: { attempts: 1, baseMs: 1 } });
    await bridge.recall("q", "s"); await bridge.recall("q", "s");
    expect(client.recall).toHaveBeenCalledTimes(1);
  });
  it("输入超长被截断", async () => {
    const client = makeClient({ capture: vi.fn().mockResolvedValue({} as any) });
    const bridge = new TdaiBridge(client, { retry: { attempts: 1, baseMs: 1 } });
    await bridge.capture({ userText: "x".repeat(2_000_000), assistantText: "y" }, "s");
    expect((client.capture as any).mock.calls[0][0].user_text.length).toBe(1_000_000);
  });
});
```
Run: `npx vitest run src/adapters/tdai-bridge/tdai-bridge.test.ts` → PASS(4/4)

- [ ] **Step 7: checkpoint(可 commit,需用户同意)**

```bash
git add src/adapters/tdai-bridge/ src/adapters/gateway-client/ 2>/dev/null
# 等待用户确认后:git commit -m "feat(bridge): add TdaiBridge thin adapter over #316 client"
```

---

## Task 2: Trae hook-handler(复用 #517,适配 Trae 事件)

**Files:**
- Create: `src/adapters/trae/hook-handler.ts`
- Create: `src/adapters/trae/hook-handler.test.ts`

**Interfaces:**
- Consumes: Task 1 `TdaiBridge`
- Produces: `async function handleTraeHook(event: TraeHookEvent, input: TraeHookInput, bridge: TdaiBridge): Promise<TraeHookOutput>`,其中 `TraeHookEvent ∈ {"SessionStart","UserPromptSubmit","Stop","SessionEnd"}`;`TraeHookOutput` 可含 `additionalContext: string`

> **实现前置(实测)**:Trae 兼容 Claude Code hooks 协议(stdin JSON)。先确认 Trae 实际字段:`UserPromptSubmit` 的 prompt 字段名、`Stop` 的 assistant 消息字段名、输出 `additionalContext` 是否被 Trae 读取。配置用 `.trae/hooks.json` + 内置「导入 Claude Code hooks」开关。字段以实测为准,下方按 Claude Code 兼容命名。

- [ ] **Step 1: 写失败测试 — UserPromptSubmit 触发 recall + additionalContext**

```ts
// src/adapters/trae/hook-handler.test.ts
import { describe, it, expect, vi } from "vitest";
import { handleTraeHook } from "./hook-handler.js";
import { TdaiBridge } from "../tdai-bridge/tdai-bridge.js";

function fakeBridge(recallCtx = "RECALLED") {
  return {
    recall: vi.fn().mockResolvedValue({ context: recallCtx }),
    capture: vi.fn().mockResolvedValue({ ok: true }),
    endSession: vi.fn().mockResolvedValue(undefined),
  } as unknown as TdaiBridge;
}

describe("handleTraeHook", () => {
  it("UserPromptSubmit → recall + bounded additionalContext", async () => {
    const bridge = fakeBridge();
    const out = await handleTraeHook("UserPromptSubmit", { prompt: "how do I X" }, bridge);
    expect(bridge.recall).toHaveBeenCalledWith("how do I X", expect.any(String));
    expect(out.additionalContext).toContain("RECALLED");
  });
  it("Stop → capture(user, assistant)", async () => {
    const bridge = fakeBridge();
    await handleTraeHook("Stop", { last_assistant_message: "answer" }, bridge);
    expect(bridge.capture).toHaveBeenCalledWith(expect.objectContaining({ assistantText: "answer" }), expect.any(String));
  });
  it("SessionEnd → endSession", async () => {
    const bridge = fakeBridge();
    await handleTraeHook("SessionEnd", {}, bridge);
    expect(bridge.endSession).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `npx vitest run src/adapters/trae/hook-handler.test.ts` → FAIL(未定义)

- [ ] **Step 3: 实现 hook-handler**

```ts
// src/adapters/trae/hook-handler.ts
import type { TdaiBridge } from "../tdai-bridge/tdai-bridge.js";

export type TraeHookEvent = "SessionStart" | "UserPromptSubmit" | "Stop" | "SessionEnd";
export interface TraeHookInput {
  prompt?: string;
  last_assistant_message?: string;
  // ponytail: Trae 实测字段补在这里(见上方实测前置)
  [k: string]: unknown;
}
export interface TraeHookOutput { additionalContext?: string; }

// 移植自 #517:有界注入,防 context 爆炸
const MAX_CONTEXT_CHARS = 4000;

export async function handleTraeHook(
  event: TraeHookEvent, input: TraeHookInput, bridge: TdaiBridge,
  sessionKey: string = String(process.env.TRACE_SESSION_KEY ?? "trae-default"),
): Promise<TraeHookOutput> {
  switch (event) {
    case "SessionStart":
    case "UserPromptSubmit": {
      const query = input.prompt ?? "";
      if (!query) return {};
      const { context } = await bridge.recall(query, sessionKey);
      if (!context) return {};
      // ponytail: 硬截断上限;超长则尾部省略
      const bounded = context.length > MAX_CONTEXT_CHARS
        ? context.slice(0, MAX_CONTEXT_CHARS) + "\n…(truncated)"
        : context;
      return { additionalContext: bounded };
    }
    case "Stop": {
      const assistantText = input.last_assistant_message ?? "";
      // ponytail: userText 在 Stop 事件未必可得;取上轮缓存或空(实现期按 Trae 实测补)
      await bridge.capture({ userText: "", assistantText }, sessionKey);
      return {};
    }
    case "SessionEnd":
      await bridge.endSession(sessionKey);
      return {};
  }
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `npx vitest run src/adapters/trae/hook-handler.test.ts` → PASS(3/3)

- [ ] **Step 5: checkpoint**(等用户同意后 commit:`feat(trae): hook-handler mapping Trae lifecycle to TdaiBridge`)

---

## Task 3: Trae MCP server(参照 #372 模式,tools 调 TdaiBridge)

**Files:**
- Create: `src/adapters/trae/mcp-server.ts`
- Create: `src/adapters/trae/mcp-server.test.ts`

**Interfaces:**
- Consumes: Task 1 `TdaiBridge`;参照 #372 的 JSON-RPC 帧解析 + closed schema 工具定义(`tdai_recall`/`tdai_capture`/`tdai_memory_search`/`tdai_conversation_search`/`tdai_session_end`)
- Produces: `class TraeMcpServer`,`runStdio(server)` 入口;通过 `TDAI_GATEWAY_URL` / `TDAI_GATEWAY_API_KEY` 配置

> **复用说明**:不直接 import #372(它内部用自己的 client),而是**参照其 JSON-RPC + closed-schema 模式新写**,tools 调 `TdaiBridge`。若 #372 已 merge 且其 `TdaiMcpServer` 可注入 gateway operations,则改为注入适配器(实现期二选一,优先复用)。

- [ ] **Step 1: 写失败测试 — tools/call 路由到 TdaiBridge**

```ts
// src/adapters/trae/mcp-server.test.ts
import { describe, it, expect, vi } from "vitest";
import { TraeMcpServer } from "./mcp-server.js";
import { TdaiBridge } from "../tdai-bridge/tdai-bridge.js";

function fakeBridge() {
  return {
    recall: vi.fn().mockResolvedValue({ context: "C" }),
    capture: vi.fn().mockResolvedValue({ ok: true }),
    searchMemory: vi.fn().mockResolvedValue([{ id: 1 }]),
    searchConversation: vi.fn().mockResolvedValue([]),
    endSession: vi.fn().mockResolvedValue(undefined),
  } as unknown as TdaiBridge;
}

describe("TraeMcpServer tools/call", () => {
  it("tdai_recall calls bridge.recall", async () => {
    const s = new TraeMcpServer(fakeBridge());
    const out = await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "tdai_recall", arguments: { query: "q", session_key: "s" } } });
    expect(out?.content?.[0]?.text).toContain("C");
  });
  it("unknown tool → JSON-RPC -32601", async () => {
    const s = new TraeMcpServer(fakeBridge());
    const out = await s.handle({ jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "nope", arguments: {} } });
    expect(out?.error?.code).toBe(-32601);
  });
});
```

- [ ] **Step 2: 运行,确认失败** → Run: `npx vitest run src/adapters/trae/mcp-server.test.ts` → FAIL

- [ ] **Step 3: 实现 mcp-server(JSON-RPC 骨架 + 5 tools 调 bridge)**

```ts
// src/adapters/trae/mcp-server.ts
import type { TdaiBridge } from "../tdai-bridge/tdai-bridge.js";

// ponytail: 手写 JSON-RPC,不引 @modelcontextprotocol/sdk(供应链安全,参照 #372)
interface JsonRpcReq { jsonrpc: string; id?: unknown; method: string; params?: any; }
interface JsonRpcRes { jsonrpc: "2.0"; id?: unknown; result?: unknown; error?: { code: number; message: string }; }

const TOOLS = [
  { name: "tdai_recall",        schema: { query: "string", session_key: "string" } },
  { name: "tdai_capture",       schema: { user_content: "string", assistant_content: "string", session_key: "string" } },
  { name: "tdai_memory_search", schema: { query: "string", limit: "number?" } },
  { name: "tdai_conversation_search", schema: { query: "string", limit: "number?" } },
  { name: "tdai_session_end",   schema: { session_key: "string" } },
];

export class TraeMcpServer {
  constructor(private bridge: TdaiBridge) {}

  async handle(req: JsonRpcReq): Promise<JsonRpcRes | undefined> {
    const id = req.id;
    if (req.method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "tdai-trae", version: "0.1.0" } } };
    if (req.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS.map(t => ({ name: t.name, inputSchema: { type: "object", properties: t.schema } })) } };
    if (req.method === "tools/call") {
      const { name, arguments: args } = req.params ?? {};
      try {
        let data: unknown;
        switch (name) {
          case "tdai_recall": data = await this.bridge.recall(args.query, args.session_key); break;
          case "tdai_capture": data = await this.bridge.capture({ userText: args.user_content, assistantText: args.assistant_content }, args.session_key); break;
          case "tdai_memory_search": data = await this.bridge.searchMemory(args.query, { limit: args.limit }); break;
          case "tdai_conversation_search": data = await this.bridge.searchConversation(args.query, { limit: args.limit }); break;
          case "tdai_session_end": await this.bridge.endSession(args.session_key); data = { ok: true }; break;
          default: return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool: ${name}` } };
        }
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(data) }] } };
      } catch (e) {
        return { jsonrpc: "2.0", id, error: { code: -32000, message: (e as Error).message } };
      }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${req.method}` } };
  }
}
```

> `runStdio` 入口、closed-schema `additionalProperties:false` 强校验、G0+G1 防御在 Step 4 补(参照 #372 对应片段)。

- [ ] **Step 4: 运行,确认通过** → Run: `npx vitest run src/adapters/trae/mcp-server.test.ts` → PASS(2/2)

- [ ] **Step 5: 补 stdio 入口 + bin**

在 `mcp-server.ts` 追加:
```ts
import * as readline from "node:readline";
import { TdaiBridge } from "../tdai-bridge/tdai-bridge.js";
import { GatewayMemoryClient } from "../gateway-client/index.js";

export async function runStdioTraeMcp(): Promise<void> {
  const client = new GatewayMemoryClient({
    baseUrl: requireEnv("TDAI_GATEWAY_URL"),
    apiKey: process.env.TDAI_GATEWAY_API_KEY,
    timeoutMs: Number(process.env.TDAI_GATEWAY_TIMEOUT_MS ?? 10000),
  });
  const server = new TraeMcpServer(new TdaiBridge(client));
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    try {
      const req = JSON.parse(line);
      const res = await server.handle(req);
      if (res) process.stdout.write(JSON.stringify(res) + "\n");
    } catch { /* ponytail: parse error → 跳过单帧,不崩 server */ }
  }
}
function requireEnv(k: string): string { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v; }
```

- [ ] **Step 6: checkpoint**(`feat(trae): MCP stdio server, 5 tools over TdaiBridge`)

---

## Task 4: trae-plugin 装载(配置 + 入口)

**Files:**
- Create: `trae-plugin/.trae/hooks.json`
- Create: `trae-plugin/.trae/mcp.json`
- Create: `trae-plugin/scripts/memory-hook.mjs`
- Create: `trae-plugin/README.md`

- [ ] **Step 1: hooks.json(声明 Trae 生命周期 hook → memory-hook.mjs)**

```json
{
  "hooks": {
    "SessionStart":     [{ "command": "node ${TRAE_PLUGIN_DIR}/scripts/memory-hook.mjs", "args": ["SessionStart"] }],
    "UserPromptSubmit": [{ "command": "node ${TRAE_PLUGIN_DIR}/scripts/memory-hook.mjs", "args": ["UserPromptSubmit"] }],
    "Stop":             [{ "command": "node ${TRAE_PLUGIN_DIR}/scripts/memory-hook.mjs", "args": ["Stop"] }],
    "SessionEnd":       [{ "command": "node ${TRAE_PLUGIN_DIR}/scripts/memory-hook.mjs", "args": ["SessionEnd"] }]
  }
}
```
> 字段格式以 Trae 实测为准(Trae「导入 Claude Code hooks」开关兼容 Claude Code 的 hooks.json)。

- [ ] **Step 2: memory-hook.mjs(读 stdin → 调编译产物 hook-handler → 输出 additionalContext)**

```js
// trae-plugin/scripts/memory-hook.mjs
import { handleTraeHook } from "../dist/trae/hook-handler.js";
import { TdaiBridge } from "../dist/tdai-bridge/tdai-bridge.js";
import { GatewayMemoryClient } from "../dist/gateway-client/index.js";

const event = process.argv[2];
const input = await readStdinJson();
const client = new GatewayMemoryClient({
  baseUrl: process.env.TDAI_GATEWAY_URL,
  apiKey: process.env.TDAI_GATEWAY_API_KEY,
});
const out = await handleTraeHook(event, input, new TdaiBridge(client));
process.stdout.write(JSON.stringify(out)); // additionalContext 注入

async function readStdinJson() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf-8")); } catch { return {}; }
}
```

- [ ] **Step 3: mcp.json**

```json
{ "mcpServers": { "tdai": { "command": "memory-tencentdb-trae-mcp", "env": {
  "TDAI_GATEWAY_URL": "${TDAI_GATEWAY_URL}", "TDAI_GATEWAY_API_KEY": "${TDAI_GATEWAY_API_KEY}" } } } }
```

- [ ] **Step 4: README** — 安装步骤、Trae 配置导入、env 变量、排错(参照 #516 `docs/codex-adapter.md` 结构)。

- [ ] **Step 5: checkpoint**(`feat(trae): plugin loader — hooks.json/mcp.json/entry`)

---

## Task 5: 导出 + 打包

**Files:**
- Create: `src/adapters/trae/index.ts`
- Modify: `src/adapters/index.ts`(追加 trae + tdai-bridge 导出)
- Modify: `package.json`(注册 bin `memory-tencentdb-trae-mcp`)
- Modify: `tsdown.config.ts`(bundle 配置)

- [ ] **Step 1: barrel 导出**

```ts
// src/adapters/trae/index.ts
export { handleTraeHook } from "./hook-handler.js";
export type { TraeHookEvent, TraeHookInput, TraeHookOutput } from "./hook-handler.js";
export { TraeMcpServer, runStdioTraeMcp } from "./mcp-server.js";
```
```ts
// src/adapters/index.ts 追加
export { TdaiBridge } from "./tdai-bridge/tdai-bridge.js";
export type { BridgeOpts } from "./tdai-bridge/tdai-bridge.js";
export * from "./trae/index.js";
```

- [ ] **Step 2: package.json bin**

```json
"bin": { "memory-tencentdb-trae-mcp": "./dist/trae/mcp-server.js" }
```

- [ ] **Step 3: 构建验证**

Run: `pnpm build && node -e "import('./dist/adapters/trae/index.js').then(m=>console.log(Object.keys(m)))"`
Expected: 打印导出键,无报错。

- [ ] **Step 4: checkpoint**(`build: export trae + tdai-bridge, register mcp bin`)

---

## Task 6: 对比文档 + Trae 适配指南 + CI

**Files:**
- Create: `docs/platform-adapters-comparison.md`(6 平台 × 6 维度 + 3 Mermaid)
- Create: `docs/trae-adapter.md`
- Modify: `README.md` / `README_CN.md`(索引到 Trae 适配,各 +2 行)
- Modify: `.github/workflows/pr-ci.yml`(若需补 trae 测试 job)

- [ ] **Step 1: 对比文档** — 表格(OpenClaw/Hermes/Codex/Claude Code/Dify/Trae × 接入模式/改core/client/L0读写/reliability/MCP)+ 3 Mermaid(组件架构、recall 读路径、L0→L3 写路径)。数据源:main 现有 + PR #515/#516/#517/#394 当前方案。
- [ ] **Step 2: Trae 适配指南** — 配置、env、验证步骤(参照 #516 `docs/codex-adapter.md`)。
- [ ] **Step 3: README 索引 + CI** — 双语各 +2 行链接;CI 确认 `pnpm test && pnpm build` 通过。
- [ ] **Step 4: 全量验证**

Run: `pnpm test && pnpm build && pnpm lint`
Expected: 全绿。

- [ ] **Step 5: checkpoint**(`docs: platform comparison + trae adapter guide`)

---

## Self-Review(plan 对 spec 覆盖核对)

- **Spec §4.1 TdaiBridge** → Task 1 ✅(concrete class、retry/cache/sanitize/degrade 全覆盖)
- **Spec §4.2 Trae hooks + MCP** → Task 2 + Task 3 + Task 4 ✅
- **Spec §4.3 对比文档** → Task 6 ✅
- **Spec §4.4 测试** → 每个 Task 内嵌 TDD ✅
- **Spec §6 不做项** → Global Constraints 固化(不改 core/不自写 client/无 G2-G4/无 Python)✅
- **Placeholder 扫描**:无 TBD;Trae hooks 实测字段已显式标为「实现前置 Step」,非 placeholder。
- **类型一致**:`TdaiBridge` 方法名(recall/capture/searchMemory/searchConversation/endSession)在 Task 1/2/3 一致;`GatewayMemoryClient` import 路径一致。

## 风险(实现期关注)

1. **Trae hooks stdin 字段**:Task 2 Step 1 前实测(用 Trae「导入 Claude Code hooks」开关验证 prompt/assistant/additionalContext 字段)。
2. **#316/#372 未 merge**:Task 1 Step 1 给了 vendoring 兜底;Task 3 优先复用 #372 的 `TdaiMcpServer` 若已 merge。
3. **每 task commit** 需用户同意(Global Constraints 已固)。
