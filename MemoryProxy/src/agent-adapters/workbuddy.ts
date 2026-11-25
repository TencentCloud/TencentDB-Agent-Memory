/**
 * WorkBuddy 桌面客户端适配器。
 *
 * 侦查依据（2026-08-10逆向 workbuddy Mac 客户端 5.3.11 抓包证据）：
 *
 * # 客户端架构
 *   - Electron GUI（腾讯官方"桌面 AI 智能体"，产品页 www.codebuddy.cn/work/）
 *   - 桌面壳层通过 ACP over HTTP（本地 127.0.0.1 sidecar）与本地 `@genie/agent-cli`
 *     通信；真正的远程 LLM 请求由 sidecar 发出（`cli/dist/codebuddy.js`）
 *   - 底层库：`@openai/agents 0.5.2`（OpenAI 官方 Agents SDK）
 *
 * # Wire protocol
 *   - 协议 = **OpenAI Responses API**（不是 Chat Completions）
 *   - endpoint 后缀：`/responses`（主）、`/responses/compact`、
 *     `/realtime/calls`、`/memories/trace_summarize`
 *   - stream 走 SSE / WebSocket（`ensureResponsesWebSocketPath` 存在，但 HTTP 亦支持）
 *   - Base URL 可通过 `OPENAI_BASE_URL` / `OPENAI_ENDPOINT`覆盖 →
 *     **接proxy 只需环境变量重定向，客户端二进制无需魔改**
 *   - 认证：`Authorization: Bearer <token>`（token 来源环境变量
 *     `CODEBUDDY_AUTH_TOKEN` / `CODEBUDDY_API_KEY`）+独立 `X-User-Id` header
 *
 * # 独有 header 集合（抓包 grep 命中）
 *   - `X-Agent-Intent` / `X-Agent-Purpose`
 *   - `X-User-Id`（URL-encode）
 *   - `X-Codebuddy-Run-Timeout`（注：header key沿用 codebuddy 前缀，
 *     是 sidecar 继承自 codebuddy CLI 的历史遗产）
 *
 * # System prompt 结构（`resources/templates/workbuddy-prompt.tpl` 抓包证据）
 *   - nunjucks 模板由客户端渲染，**proxy 收到的是渲染后成品文本**
 *   - XML tag 分节：`<content_policy>` / `<agent_skills>` / `<expert_management>`
 *     / `<mcp_configuration>` / `<response_language>` / `<binary_context>`
 *   - user message wrapper: `<user_query>...</user_query>`
 *   - 4 段 memory 占位符（本adapter 不涉及注入，injection profile 层处理）：
 *       * `{{ WorkbuddyMemory_1 }}`
 *       * `{{ WorkingMemoryContent }}`
 *       * `{{ UserLocalMemoryContent }}`
 *       * `{{ UserMemoryContent }}`
 *   - 数据目录变量：`{{ dataFolderName }}` → `.workbuddy`
 *   - 产品域名：`www.workbuddy.cn/docs/workbuddy/Overview`（**独立于 codebuddy**）
 *
 * # 两个适配点
 *   - `classifyRequest`: **独立实现**同款 aux 三层信号判定（endpoint path白名单 +
 *     memgen header + client_metadata.thread_source）——与 codex 关键字重合但零依赖
 *   - `extractUserText`: 从 responses API `body.input[]` 提取最后一条
 *     `type=message && role=user` 的 `content[].input_text` —— 独立实现，
 *     不import codex 模块
 *
 * # 独立性约束（用户明确要求）
 *   - 零 import codebuddy / codex
 *   - 关键字集合恰好与 codex 重合是"上游协议同源"的自然结果，不视为耦合
 *   - workbuddy 侧任何未来变化（新 aux path、新 header）在本文件内演进
 *
 * 详见抓包报告：MemoryProxy/docs/workbuddy-recon/*.tpl + workbuddy-cli-product.json。
 */

import { extractUserQueryText } from "../common/user-query-extractor.js";
import type { AgentAdapter, RequestKind } from "./types.js";

// ── Aux detection constants ──────────────────────────────────────────────────

/**
 * WorkBuddy 客户端已知的 aux endpoint path suffix。
 *
 * 来源：workbuddy Mac 客户端 5.3.11 逆向 `cli/dist/codebuddy.js` grep 结果：
 *   - `/responses/compact`         压缩/摘要请求
 *   - `/memories/trace_summarize`  memory 轨迹归纳
 *   - `/realtime/calls`            实时会话建立
 *
 * 未来若发现 workbuddy 新增aux endpoint，在此追加（不要修改 codex 侧）。
 */
const WORKBUDDY_AUX_PATH_SUFFIXES: readonly string[] = [
  "/responses/compact",
  "/memories/trace_summarize",
  "/realtime/calls",
];

/**
 * WorkBuddy 客户端已知的 aux 类型 body.client_metadata.thread_source 值。
 *
 *抓包尚未确证 workbuddy 是否使用 client_metadata；此处保守只放 codex 已知
 * 的两个白名单值（若workbuddy 底层 SDK 与 codex 同源，理论上一致）。
 * 未知一律main（偏严不偏宽）。
 */
const WORKBUDDY_AUX_THREAD_SOURCES:ReadonlySet<string> = new Set([
  "memory_consolidation",
  "system",
]);

/**
 * WorkBuddy 特有的 memgen 请求头 key 集合。
 *
 *抓包证据显示 workbuddy sidecar 继承自 codebuddy CLI，仍在使用
 * `x-openai-memgen-request` 标记 memory generation 请求。
 * 独立列出，不 import codex 常量。
 */
const WORKBUDDY_MEMGEN_HEADER_KEYS: readonly string[] = [
  "x-openai-memgen-request",
];

/**
 * 判定 workbuddy 请求是否为 aux（辅助请求）。
 *
 * 三层信号按优先级：
 *   1. endpoint path suffix 白名单（最强）
 *   2. memgen 请求头（memory consolidation 独占）
 *   3. body.client_metadata.thread_source 白名单
 */
function isWorkbuddyAuxiliary(
  path: string | undefined,
  headers: Record<string, string> | undefined,
  body: Record<string, unknown>,
): boolean {
  // 信号 1: aux endpoint（path 白名单）
  if (path) {
    for (const suffix of WORKBUDDY_AUX_PATH_SUFFIXES) {
      if (path.endsWith(suffix)) return true;
    }
  }

  // 信号 2: memgen 请求头
  if (headers) {
    for (const key of WORKBUDDY_MEMGEN_HEADER_KEYS) {
      if (headers[key] === "true") return true;
    }
  }

  // 信号 3: body.client_metadata.thread_source 命中白名单
  const meta = body.client_metadata as { thread_source?: string } | undefined;
  const ts = meta?.thread_source;
  if (typeof ts === "string" && WORKBUDDY_AUX_THREAD_SOURCES.has(ts)) return true;

  return false;
}

// ── User text extraction ─────────────────────────────────────────────────────

/**
 * 从 workbuddy 请求体提取最后一条 user 消息的纯文本 —— **双形态兼容**。
 *
 * ⚠️ 关键事实（2026-10-19 实测修正，此前本文档假设是错的）：
 *   workbuddy 有**两条**链路，body 形态完全不同：
 *
 *   1) **主对话** → `/workbuddy/<sid>/v1/chat/completions`
 *      由 `openai-chat.ts` runner 处理（server.ts:384 通配路由命中）。
 *      body 是 **OpenAI Chat Completions** 形态：
 *        messages: [{ role:"user", content:[{type:"text", text:"..."}] }, ...]
 *      ⚠️ item **没有** `type:"message"` 字段，block type 是 `"text"`。
 *
 *   2) **aux 端点** → `/workbuddy/<sid>/v1/responses`（+ compact / realtime /
 *      memories）由 `workbuddy.ts` runner 处理。
 *      body 是 **OpenAI Responses API** 形态（底层 @openai/agents SDK）：
 *        input: [{ type:"message", role:"user",
 *                  content:[{type:"input_text", text:"..."}] }, ...]
 *
 * 原实现只认形态 2，导致主对话（形态 1）的 `content[{type:"text"}]`
 * 在两个 `continue` 上全部落空 → 返回 null → `parseMemCommand` 提前
 * return null → **mem: 命令被静默透传给上游 LLM**（LLM 只能编造回复）。
 * 用户实测 `mem:config-lock` / `mem:config-unlock` 在 workbuddy 上完全
 * 不可用，而 codebuddy / claude-code 正常 —— 根因就在这里。
 *
 * 修复策略：**先按形态 2 找（保持 aux 行为不变），找不到再按形态 1 找**。
 * block type 同时认 `input_text` 与 `text`，两条形态共用同一套拼接语义。
 */
function extractWorkbuddyUserText(input: unknown): string | null {
  if (!Array.isArray(input)) return null;

  // ── 形态 1: Responses API (aux 端点) —— {type:"message", role:"user"} ──
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i] as Record<string, unknown> | null | undefined;
    if (!item || typeof item !== "object") continue;
    if (item.type !== "message" || item.role !== "user") continue;

    const content = item.content;
    if (!Array.isArray(content)) continue;

    const texts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown> | null | undefined;
      if (!b || typeof b !== "object") continue;
      if (b.type === "input_text" && typeof b.text === "string") {
        texts.push(b.text);
      }
    }
    return texts.length > 0 ? texts.join("\n") : null;
  }

  // ── 形态 2: Chat Completions (主对话) —— {role:"user"}，无 type:"message" ──
  // 与形态 1 分开扫：形态 1 命中即返回，只有它没命中才走到这里，
  // 保证 aux 链路行为字节级不变。
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i] as Record<string, unknown> | null | undefined;
    if (!item || typeof item !== "object") continue;
    if (item.role !== "user") continue;

    const content = item.content;
    if (!Array.isArray(content)) continue;

    const texts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown> | null | undefined;
      if (!b || typeof b !== "object") continue;
      // 主对话 block type 是 "text"；兼容少数客户端发 "input_text"。
      if (
        (b.type === "text" || b.type === "input_text") &&
        typeof b.text === "string"
      ) {
        texts.push(b.text);
      }
    }
    if (texts.length > 0) return texts.join("\n");
  }

  return null;
}

// ── Adapter export ───────────────────────────────────────────────────────────

/**
 * 提取用户真实输入 —— 双形态兼容：
 *
 * 1) **Responses API (`/v1/responses`)**：桌面客户端专属，content 是 `input[]`
 *    数组（`{type:"message", role:"user", content:[{type:"input_text", text}]}`），
 *    走 `extractWorkbuddyUserText` 独立算法。
 *
 * 2) **Chat Completions (`/v1/chat/completions`)**：workbuddy 网页版底层用的是
 *    OpenAI ChatCompletions（`claude-opus-4.7-1m` + OpenAI 兼容上游），
 *    走通用主 handler 路径。`message.content` 是字符串，且带 CC/CB 同款
 *    `<system-reminder>` / `<user_query>` wrapper（2026-08-12 日志实证）。
 *    直接复用 CB 的 `extractUserQueryText` —— 与 tdai L0 / mem-command
 *    保持同一份剥离语义。
 *
 * 修复背景：2026-08-12 用户在 workbuddy 网页版发 `mem:help`，请求进 proxy 后走
 * `/chat/completions`（handler.ts::handleChatCompletions），parseMemCommand 调
 * `workbuddyAdapter.extractUserText(content)`，但原实现只处理 Array，字符串
 * content 返 null → 命令识别失败 → 透传给 LLM 兜底。见 develop_timestone/。
 */
export const workbuddyAdapter: AgentAdapter = {
  agentKind: "workbuddy",

  classifyRequest(
    body: Record<string, unknown>,
    path?: string,
    headers?: Record<string, string>,
  ): RequestKind {
    return isWorkbuddyAuxiliary(path, headers, body) ? "auxiliary" : "main";
  },

  extractUserText(content: unknown): string | null {
    // ── 形态 A: 字符串 content（网页版 chat/completions，可能带 <user_query> wrapper）
    if (typeof content === "string") {
      const extracted = extractUserQueryText(content);
      if (extracted.length > 0) return extracted;
      return null;
    }

    if (!Array.isArray(content)) return null;

    // ── 形态 B: Responses API input[]（{type:"message", role:"user", ...}）
    //    只有 aux 端点走这条，先判，命中即返回，保持 aux 行为不变。
    const responsesText = extractWorkbuddyUserText(content);
    if (responsesText) return responsesText;

    // ── 形态 C: Chat Completions 的**单条消息 content 数组**
    //    parseMemCommand 传的是 lastMsg.content = [{type:"text", text:"..."}]，
    //    元素是 block（没有 role / type:"message" 字段），形态 B 必然落空。
    //
    //    ⚠️ 这是 2026-10-19 修复的核心：workbuddy **主对话**走
    //    /workbuddy/<sid>/v1/chat/completions（由 openai-chat runner 处理），
    //    body 就是这个形态。修复前落到形态 B 返回 null → mem: 命令静默透传给
    //    LLM。这里对齐 codebuddyAdapter：无 wrapper 时用 defaultAdapter 语义
    //    （收集所有 type==="text" 的 block）。
    //
    //    有 <user_query> wrapper 时（形态 C 也可能带）优先走剥离逻辑，
    //    与字符串分支保持同一份语义。
    for (let i = content.length - 1; i >= 0; i--) {
      const b = content[i] as Record<string, unknown> | null | undefined;
      if (!b || typeof b !== "object") continue;
      if (typeof b.text !== "string") continue;
      // 主对话 block type 是 "text"；aux 兼容 "input_text"。
      if (b.type !== "text" && b.type !== "input_text") continue;
      const extracted = extractUserQueryText(b.text);
      if (extracted.length > 0) return extracted;
    }

    return null;
  },
};
