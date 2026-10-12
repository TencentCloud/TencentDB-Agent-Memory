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
 * 从 workbuddy responses API `body.input[]` 提取最后一条
 * `type=message && role=user` 的 `content[].input_text` 拼接文本。
 *
 *抓包证据：workbuddy 底层用 @openai/agents SDK，wire body 结构与
 * OpenAI Responses API 完全一致。input[] item 已知类型：
 *   - {type:"message", role:"user"|"assistant"|"developer"|"system",
 *      content:[{type:"input_text"|"output_text"|"input_image",...}]}
 *   - {type:"function_call", name, arguments}
 *   - {type:"function_call_output", output}
 *   - {type:"reasoning", encrypted_content, ...}
 *
 * 只关心 type=message && role=user 的 content 里type=input_text 段。
 *
 * 注：独立于 codex 实现（重复算法但零耦合）；未来若 workbuddy input[]
 * 结构分化（如新增 workbuddy 特有 content type），在此文件内演进。
 */
function extractWorkbuddyUserText(input: unknown): string | null {
  if (!Array.isArray(input)) return null;

  // 从后往前找最后一条 role=user 的 message
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
    // 网页版 chat/completions：content 是字符串（可能带 <user_query> / wrapper）
    if (typeof content === "string") {
      const extracted = extractUserQueryText(content);
      return extracted.length > 0 ? extracted : null;
    }
    // 桌面客户端 /v1/responses：content 是 input[] 数组
    return extractWorkbuddyUserText(content);
  },
};
