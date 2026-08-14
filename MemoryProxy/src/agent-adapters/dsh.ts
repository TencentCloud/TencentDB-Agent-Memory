/**
 * deepseek-harness (dsh) 客户端适配器。
 *
 * 抓包实证(2026-08-14,mitmproxy 6 条真实包,详见
 * `docs/dsh-recon/2026-08-14-dsh-capture-analysis.md`):
 *
 *   - 协议:**标准 OpenAI Chat Completions**(`POST /chat/completions` + SSE),
 *     跟 codebuddy 同族;body/messages shape 100% 兼容(role:system/user/assistant/tool,
 *     tool_calls[] on assistant,单独 role=tool 消息带 tool_call_id)
 *   - 客户端指纹(强):`user-agent: deepseek-harness/*`(dsh attribution 不可关)
 *     + `x-deepseek-harness-user-id`(匿名 UUID 恒定) + `x-deepseek-harness-session-id`
 *     (session-<uuid>) + `x-deepseek-harness-compact:1`(仅 compaction 请求带)
 *   - session_id **只在 header**,body 不带 fallback 字段(跟 codex 的 client_metadata
 *     不同);proxy 侧 sid 提取 100% 依赖 header
 *   - assistant 回带 `reasoning_content`(dsh 特色,仅 tool_calls 轮回带),
 *     proxy 透传即可,不影响 messages parser
 *
 * # 三类请求的区分(main / title / compaction)
 *
 * dsh 主对话 / compaction / session-title 全部共用同一 `x-deepseek-harness-session-id`,
 * **仅 compaction 有独立 header**(compact:1),title 没有 —— 靠 body 特征区分:
 *
 * | 类别 | header 信号 | body 特征 |
 * |---|---|---|
 * | compaction | `x-deepseek-harness-compact: 1` | — |
 * | title-gen | 无 | tools 缺 + thinking.disabled + max_tokens<=128 + system 以 "Create a concise title..." 开头 |
 * | main | 无 | 其它 |
 *
 * classifyRequest 优先级:**compact header > title body-shape > main**;
 * title 判据必须**三合一都满足**才当 aux(单一特征易误判)。
 *
 * # 两个适配点
 *   - `classifyRequest`: 三重信号判(compact / title / main)
 *   - `extractUserText`: content 是 str 直接返回(dsh messages.content 从不用 blocks)
 *
 * # 不同于 CB 的地方
 *   - dsh 主对话在 body.messages 里塞 4 条 role=user:真实用户输入 +
 *     `<system-reminder>` 工作区指令 + `runtime context` 快照 + `<available_skills>` 列表
 *     —— proxy 侧提取最后一条 user 的 str content 时,取"从后往前第一条"就够;
 *     实际用户输入通常在 messages[1](第一条 user)
 *   - dsh 用户输入本身**不带 CB/workbuddy 那种 `<user_query>` wrapper**,直接透传
 */

import type { AgentAdapter, RequestKind } from "./types.js";

// ── Title-gen body-shape detection ───────────────────────────────────────────

/**
 * dsh session-title-llm 请求的 system prompt 固定前缀。
 * 来源:`packages/session/session-title-llm/src/index.ts:252-260` +
 * 抓包 `fixtures/121918-*-9d056d.req.json` 实证。
 *
 * dsh 侧 prompt 完整开头:
 *   "Create a concise title for an AI coding-assistant session from the supplied human messages."
 *
 * 只取前缀做匹配,避免上游 prompt 微调(punctuation / 换行)后判据失效。
 */
const DSH_TITLE_SYSTEM_PROMPT_PREFIX =
  "Create a concise title for an AI coding-assistant session";

/**
 * dsh title-gen 请求的 max_tokens 上限。抓包实证 `max_tokens=64`;
 * 留 128 一点富余,避免上游微调后跟着漂。
 */
const DSH_TITLE_MAX_TOKENS_CEIL = 128;

/**
 * 判定 dsh 请求是否为 title-gen(body 特征三合一)。
 *
 * 全部条件必须满足才当 aux。任一条不满足即返 false(避免误判 main)。
 */
function isDshTitleGen(body: Record<string, unknown>): boolean {
  // 条件 1: tools 缺失或空数组(主对话恒 25+ 个)
  const tools = body.tools;
  const hasTools = Array.isArray(tools) && tools.length > 0;
  if (hasTools) return false;

  // 条件 2: thinking.type === "disabled"
  const thinking = body.thinking as { type?: string } | undefined;
  if (thinking?.type !== "disabled") return false;

  // 条件 3: max_tokens <= 128
  const maxTokens = body.max_tokens;
  if (typeof maxTokens !== "number" || maxTokens > DSH_TITLE_MAX_TOKENS_CEIL) return false;

  // 条件 4: 首条 system 消息 content 以 title prompt 前缀开头
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const first = messages[0] as { role?: string; content?: unknown } | undefined;
  if (!first || first.role !== "system" || typeof first.content !== "string") return false;
  if (!first.content.startsWith(DSH_TITLE_SYSTEM_PROMPT_PREFIX)) return false;

  return true;
}

// ── User text extraction ─────────────────────────────────────────────────────

/**
 * dsh messages.content 是 str,直接返回。
 *
 * 抓包实证(fixtures/*.req.json 多条 messages 全 role=user + content:str):
 * dsh 从不用 Anthropic-style content-blocks 数组,连 tool_result 都是独立
 * role=tool 消息(而非嵌在 user 里)。
 *
 * 不做 CB 那种 `<user_query>` wrapper 剥离 —— dsh 主对话就是纯用户输入 +
 * 独立 `<system-reminder>` user 消息,没 wrapper 嵌套。
 */
function extractDshUserText(content: unknown): string | null {
  if (typeof content !== "string") return null;
  return content.length > 0 ? content : null;
}

// ── Adapter export ───────────────────────────────────────────────────────────

export const dshAdapter: AgentAdapter = {
  agentKind: "dsh",

  classifyRequest(
    body: Record<string, unknown>,
    _path?: string,
    headers?: Record<string, string>,
  ): RequestKind {
    // 信号 1(最强): compact header —— dsh source 硬编码在
    // `packages/llm/llm-deepseek/src/adapter.ts:290-293`,只在
    // `purpose:'compaction'` 时才塞,无歧义
    if (headers?.["x-deepseek-harness-compact"] === "1") return "auxiliary";

    // 信号 2: title-gen body 特征三合一(见 isDshTitleGen)
    if (isDshTitleGen(body)) return "auxiliary";

    // 其它一律 main
    return "main";
  },

  extractUserText(content: unknown): string | null {
    return extractDshUserText(content);
  },
};
