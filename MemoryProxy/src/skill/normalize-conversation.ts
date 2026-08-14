/**
 * normalize-conversation.ts
 *
 * 把 client 原始请求的 messages[] + upstream 返回的 assistantMessage 转换成
 * core `/v3/skill/conversation/add` 需要的 5-role 规范化数组:
 *   { role: "user" | "assistant" | "tool_call" | "tool_result" | "system",
 *     content: string,
 *     tool_call_id?: string,
 *     tool_name?: string }
 *
 * 明确按协议分支:
 *   protocol="anthropic" → Anthropic Messages API (Claude Code, /v1/messages)
 *     - user 里 content 可能是 blocks 数组, tool_result 藏在 role=user 的 blocks 里
 *     - assistant 里 tool_use 藏在 content blocks 里
 *   protocol="openai"    → OpenAI Chat Completions (CodeBuddy, /v1/chat/completions)
 *     - tool_result 是独立 role=tool 消息 (只有 tool_call_id, 没有 tool_name)
 *     - assistant.tool_calls 是独立数组字段
 *   protocol="responses" → OpenAI Responses API (Codex CLI, /responses)
 *     - 顶层字段是 `input[]` 而非 `messages[]`, item 由 `type` 判别:
 *         · type="message" role=user/assistant/developer → content[].input_text|output_text
 *         · type="function_call" → 独立顶层项, 含 call_id / name / arguments
 *         · type="function_call_output" → 独立顶层项, 含 call_id / output
 *         · type="reasoning" → 内部思考, 一律丢弃 (跟 anthropic thinking 对齐)
 *     - developer message 等同 openai role=system, 丢弃 (不进 skill 语料)
 *     - assistant 侧 tool 调用不是 embedded 到 message.content, 而是独立 item, 因此
 *       "本轮 assistantMessage" 抽出来时可能包含前面若干 function_call/function_call_output
 *       跟 text 混在一起 —— caller 传 assistantMessage 时只放"响应的 assistant text 段
 *       + 本轮 stream 累积的 tool_use count override", 已存在的 input[] 里的 function_call
 *       仍由 normalizeConversation 遍历时处理。
 *
 * 关键规则 (对应 docs/design/2026-07-17-conversation-normalize.md):
 *   - Anthropic user 里全是 tool_result blocks 时 → 输出 role=tool_result, 不输出 user
 *   - Anthropic user 里 text + tool_result 混合 → 拆成两条 (role=user, role=tool_result)
 *   - Anthropic assistant 里 thinking block → 目前**完全丢弃**
 *     TODO: 后续如果需要保留 thinking, 加个 `keepThinking: boolean` 参数,
 *     保留形式为 role=assistant + content 前缀 [thinking] xxx (对齐 Opik flatten)
 *   - Anthropic image block → 丢弃 (对 skill 抽取无价值)
 *   - Anthropic assistant content 数组为空 → 该消息整个丢弃
 *   - OpenAI role=tool 消息 → tool_name 保持 undefined (core schema 已放宽为 optional)
 *
 * assistantMessage 是本轮 upstream 返回的响应, 已被 proxy 拆出来单独传:
 *   - anthropic 形态: { role: "assistant", content: <blocks 数组> }
 *   - openai 形态:    { role: "assistant", content: string | null, tool_calls?: [...] }
 *
 * 该模块不做"本轮切片"—— 调用方要发全历史还是本轮增量由 handler-glue 决定, 这里只做格式规范化。
 *
 * 除 normalizer 外, 本文件还导出两个 round 边界判定 helper:
 *   - isFinalAnswer(asst, toolCallCountOverride?):
 *       判本次响应是不是 agent 的最终回复 (无 tool_use / tool_calls)
 *   - findLastFinalAssistant(rawMessages, protocol):
 *       在 messages[] 里找上一次 final assistant 的 index (round 起点定位)
 *
 * 这两个 helper 由 handler-glue 用来实现 round-level 触发: 只有 final answer
 * 时才 push 到 core, 中间态跳过, 避免"每次 HTTP 都发一次增量"导致 core buffer
 * 累计爆炸 (10 次 tool_use 或 40KB 就触发一次归档)。
 */

import { resolveAgentAdapter } from "../agent-adapters/index.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export type Protocol = "anthropic" | "openai" | "responses";

/** 输出格式, 对应 core conversationMessageSchema。 */
export interface NormalizedMessage {
  role: "user" | "assistant" | "tool_call" | "tool_result" | "system";
  content: string;
  tool_call_id?: string;
  tool_name?: string;
}

/** raw message shape - loose 因为三种协议的原始形态都要能塞进来。 */
interface RawMessage {
  role?: string;
  content?: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
  /**
   * codex Responses API input[] 的判别字段:
   *   "message" | "function_call" | "function_call_output" | "reasoning" | ...
   * anthropic/openai 的 message 里无此字段。
   */
  type?: string;
  [k: string]: unknown;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * 数 assistant 响应里 tool_use / tool_calls block 的个数, 用于 isFinalAnswer
 * / round 边界判定。跨协议兼容:
 *   - OpenAI: 顶层 `tool_calls: [...]` 数组长度
 *   - Anthropic: content blocks 里 `type === "tool_use"` 的数量
 * 其他形态一律 0 (纯 text 或空响应)。
 */
export function countToolCalls(assistantMessage: Record<string, unknown> | null | undefined): number {
  if (!assistantMessage) return 0;
  // OpenAI: top-level `tool_calls: [...]`
  const tc = assistantMessage.tool_calls;
  if (Array.isArray(tc)) return tc.length;
  // Anthropic: content blocks
  const content = assistantMessage.content;
  if (Array.isArray(content)) {
    let n = 0;
    for (const block of content) {
      const t = (block as Record<string, unknown>)?.type;
      if (t === "tool_use") n++;
      // Codex Responses API: assistant "message" 只含 output_text; function_call
      // 是 sibling item, 不在 assistant.content 里出现。所以 responses 场景
      // countToolCalls(assistantMessage) 恒 0 —— 真正的 tool call 数由 stream
      // accumulator 的 toolCallCountOverride 传入 (跟 anthropic stream 一致)。
    }
    return n;
  }
  return 0;
}

/**
 * 判本次 assistantMessage 是不是 agent 的最终回复 (round 结束).
 *
 * 判定标准：**没有 tool_use / tool_calls** —— 有 text 无所谓，因为可能出现
 * "text + tool_use 混合"的中间态（agent 边说话边调工具）。这种情况下 round
 * 还没结束，text 部分会作为历史保留到 messages[]，下次真正 final 时再一起
 * slice 进本 round。
 *
 * 两个协议的区分:
 *   - anthropic non-stream: 直接看 asst.content blocks 里有没有 tool_use
 *   - anthropic stream:     content 被 proxy 拉平成 string 了（丢了 blocks 信息），
 *                           调用方必须传 toolCallCountOverride
 *   - openai:               看 asst.tool_calls[] 长度
 *
 * 复用本文件 countToolCalls 处理协议差异, 这里只加 override 优先级.
 */
export function isFinalAnswer(
  asst: RawMessage | null | undefined,
  toolCallCountOverride?: number,
): boolean {
  if (!asst) return false;
  // stream 场景: override 是权威来源, content 已丢 blocks 结构不能靠它判
  if (toolCallCountOverride !== undefined) {
    return toolCallCountOverride === 0;
  }
  return countToolCalls(asst as Record<string, unknown>) === 0;
}

/**
 * 找 messages[] 里最近一条"最终回复形态"的 assistant index —— 定义为
 * role=assistant 且响应内没有 tool_use / tool_calls。返回 -1 表示历史里全是
 * 中间态 / 没有 assistant, 调用方应从 index 0 开始 slice。
 *
 * 用途: 在 handler-glue 里定位本 round 起点 —— 从"上一次 final assistant"
 * 之后 slice, 就是本 round 完整对话 (user + 中间 tool_use/tool_result... +
 * 本次 assistantMessage)。
 *
 * 协议差异:
 *   - anthropic: 历史 messages 里 assistant.content 可能是 string (纯 text final)
 *                或 blocks 数组 (混合)。只要 blocks 里没 tool_use 就算 final。
 *   - openai:    历史 messages 里 assistant 可能有 tool_calls 字段。只要
 *                tool_calls 为空/缺失就算 final。
 */
export function findLastFinalAssistant(
  rawMessages: RawMessage[],
  protocol: Protocol,
): number {
  if (protocol === "responses") {
    // Codex `input[]` 里 assistant 用 `{type:"message", role:"assistant"}`;
    // 它的 tool 调用是 sibling item `{type:"function_call", ...}` 而非
    // 内嵌 block。判 "本条 assistant 是 final" 的规则：从该 index 往后扫,
    // 只要在遇到下一条 role=user 的 message 之前**没有** function_call
    // (以及配套的 function_call_output) 出现, 就算 final answer, 本轮结束。
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      const m = rawMessages[i];
      if (!m || m.type !== "message" || m.role !== "assistant") continue;
      // 扫 tail 看有没有 function_call
      let hasFnCall = false;
      for (let j = i + 1; j < rawMessages.length; j++) {
        const next = rawMessages[j];
        if (!next || typeof next !== "object") continue;
        if (next.type === "function_call") { hasFnCall = true; break; }
        if (next.type === "message" && next.role === "user") break;   // 到了下一轮
      }
      if (!hasFnCall) return i;
    }
    return -1;
  }
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const m = rawMessages[i];
    if (!m || m.role !== "assistant") continue;
    if (isFinalAnswer(m)) {
      // isFinalAnswer 对两种协议都靠 countToolCalls 判定, 覆盖:
      //   anthropic: content 是 string → tool_use=0 → final
      //              content 是 blocks 且无 tool_use → tool_use=0 → final
      //   openai:    tool_calls=[] 或缺失 → tool_use=0 → final
      // (protocol 参数保留是为将来扩展更细粒度的判定, 目前不用)
      void protocol;
      return i;
    }
  }
  return -1;
}

export function normalizeConversation(
  rawMessages: RawMessage[],
  protocol: Protocol,
  assistantMessage: RawMessage | null,
  agentSource: string = "claude-code",
): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  // 兜底: protocol=responses 但 agentSource 默认为 claude-code (老调用方没传)
  // → 强制切到 codex adapter, 否则 extractUserText 会用错客户端规则返 null,
  // 归档链路整个断掉。
  const effectiveAgentSource = protocol === "responses" && agentSource === "claude-code"
    ? "codex"
    : agentSource;
  const convertOne = (m: RawMessage): NormalizedMessage[] => {
    if (protocol === "anthropic") return convertAnthropicMessage(m, effectiveAgentSource);
    if (protocol === "openai") return convertOpenAIMessage(m, effectiveAgentSource);
    return convertCodexInputItem(m, effectiveAgentSource);
  };
  for (const m of rawMessages) {
    if (!m || typeof m !== "object") continue;
    for (const c of convertOne(m)) out.push(c);
  }
  if (assistantMessage) {
    // 对 responses 协议, upstream 只回 assistant text (function_call 在流里
    // 单独识别并已进入 input[] 下一轮请求, 归档时通过 rawMessages 遍历覆盖),
    // 所以这里只补一条 role=assistant + text —— 复用 convertCodexInputItem
    // 走同一路径, 保持与另外两协议对称。
    const asst: RawMessage = protocol === "responses"
      ? { type: "message", role: "assistant", ...assistantMessage }
      : { role: "assistant", ...assistantMessage };
    // 保险: 显式设 role=assistant 以防调用方传入的 assistantMessage 缺 role;
    // convertOne 依赖 effectiveAgentSource, 上面已覆盖 protocol=responses 兜底。
    asst.role = "assistant";
    for (const c of convertOne(asst)) out.push(c);
  }
  return out;
}

// ─── Anthropic ─────────────────────────────────────────────────────────────

function convertAnthropicMessage(msg: RawMessage, agentSource: string): NormalizedMessage[] {
  const role = msg.role;
  const content = msg.content;

  // role=system: 丢弃, 不发给 core。
  // 客户端固定 agent instruction (CodeBuddy 26KB / Claude Code 也不小) 跟
  // skill 抽取无关, 计入 40KB bytes 阈值只会让归档节奏乱套。两侧协议统一处理:
  //   - Anthropic: system 本来就在 body.system 顶层, messages 里出现是少数场景
  //   - OpenAI:    system 在 messages[0], 每次 request 都带一份
  // 详见 handler-glue.ts 上游 normalize 调用点。
  if (role === "system") {
    return [];
  }

  if (role === "assistant") {
    return convertAnthropicAssistant(content);
  }

  if (role === "user") {
    return convertAnthropicUser(content, agentSource);
  }

  // 其它 role 一律 drop
  return [];
}

function convertAnthropicAssistant(content: unknown): NormalizedMessage[] {
  // content 可能是 string / array of blocks
  if (typeof content === "string") {
    return content.length > 0 ? [{ role: "assistant", content }] : [];
  }
  if (!Array.isArray(content)) {
    // 兜底: 结构化对象但不是数组 → 序列化
    return [{ role: "assistant", content: contentToString(content) }];
  }

  const out: NormalizedMessage[] = [];
  const textParts: string[] = [];
  const toolCalls: NormalizedMessage[] = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const t = b.type;

    if (t === "text") {
      const txt = b.text;
      if (typeof txt === "string" && txt.length > 0) textParts.push(txt);
    } else if (t === "tool_use") {
      // 转成 role=tool_call, tool_name 从 name, tool_call_id 从 id
      const id = typeof b.id === "string" ? b.id : "";
      const name = typeof b.name === "string" ? b.name : undefined;
      const inputStr = safeStringify(b.input);
      const tc: NormalizedMessage = {
        role: "tool_call",
        content: inputStr,
        tool_call_id: id,
      };
      if (name) tc.tool_name = name;
      toolCalls.push(tc);
    }
    // 其它 block type (thinking / redacted_thinking / image / ...) 一律丢弃
  }

  if (textParts.length > 0) {
    out.push({ role: "assistant", content: textParts.join("\n") });
  }
  for (const tc of toolCalls) out.push(tc);
  return out;
}

function convertAnthropicUser(content: unknown, agentSource: string): NormalizedMessage[] {
  if (typeof content === "string") {
    return [{ role: "user", content }];
  }
  if (!Array.isArray(content)) {
    return [{ role: "user", content: contentToString(content) }];
  }

  const out: NormalizedMessage[] = [];
  const toolResults: NormalizedMessage[] = [];

  // 收集所有 tool_result（单独输出成 role=tool_result 消息）
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "tool_result") continue;
    const id = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
    // tool_result.content 可能是 string / array of {type:"text",text} / other
    const resultText = anthropicToolResultContentToString(b.content);
    toolResults.push({
      role: "tool_result",
      content: resultText,
      tool_call_id: id,
      // 注意: anthropic tool_result 没有 tool_name 字段, proxy 也不做反查
      // (core schema 已放宽为 optional)
    });
  }

  // text 部分：通过 agentAdapter 按客户端规则提取"用户真正键入的文本"：
  //   - claude-code: 取最后一个 text block（跳过 <system-reminder> 前缀元数据）
  //   - codebuddy / unknown: 走保守的"拼接所有 text"（等价改造前老逻辑）
  const adapter = resolveAgentAdapter(agentSource);
  const userText = adapter.extractUserText(content);
  if (typeof userText === "string" && userText.length > 0) {
    out.push({ role: "user", content: userText });
  }
  for (const tr of toolResults) out.push(tr);
  return out;
}

function anthropicToolResultContentToString(rc: unknown): string {
  if (typeof rc === "string") return rc;
  if (Array.isArray(rc)) {
    const parts: string[] = [];
    for (const b of rc) {
      if (!b || typeof b !== "object") continue;
      const bb = b as Record<string, unknown>;
      if (bb.type === "text" && typeof bb.text === "string") {
        parts.push(bb.text);
      }
      // 忽略 image 等其它 block type
    }
    return parts.join("\n");
  }
  return contentToString(rc);
}

// ─── OpenAI ────────────────────────────────────────────────────────────────

function convertOpenAIMessage(msg: RawMessage, agentSource: string): NormalizedMessage[] {
  const role = msg.role;
  const content = msg.content;

  // role=system: 丢弃, 不发给 core。跟 anthropic 分支一致, 详见那边注释。
  if (role === "system") {
    return [];
  }
  if (role === "user") {
    // 通过 adapter 按客户端规则提取"用户真正键入的文本"，跟 anthropic 侧对称：
    //   - codebuddy: 走 <user_query> 抽取（剥掉 <user_info> / <additional_data> /
    //     <question_answer> 等 CB pseudo-XML wrapper），返回 null 时该轮不进
    //     skill buffer（避免污染 skill 抽取语料）
    //   - unknown / cursor 等: 走 default 兜底（拼接所有 text，等价改造前老逻辑）
    // 详见 agent-adapters/codebuddy.ts + common/user-query-extractor.ts。
    const adapter = resolveAgentAdapter(agentSource);
    const userText = adapter.extractUserText(content);
    if (typeof userText === "string" && userText.length > 0) {
      return [{ role: "user", content: userText }];
    }
    return [];
  }
  if (role === "tool") {
    // openai role=tool → role=tool_result
    const id = typeof msg.tool_call_id === "string" ? msg.tool_call_id : "";
    return [{
      role: "tool_result",
      content: contentToString(content),
      tool_call_id: id,
      // tool_name 未提供 —— core schema 已 optional
    }];
  }
  if (role === "assistant") {
    return convertOpenAIAssistant(content, msg.tool_calls);
  }
  return [];
}

function convertOpenAIAssistant(content: unknown, toolCalls: unknown): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];

  // text part
  const contentStr = typeof content === "string" ? content : (content == null ? "" : contentToString(content));
  if (contentStr.length > 0) {
    out.push({ role: "assistant", content: contentStr });
  }

  // tool_calls (openai standard)
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== "object") continue;
      const t = tc as Record<string, unknown>;
      const id = typeof t.id === "string" ? t.id : "";
      const fn = t.function as Record<string, unknown> | undefined;
      const name = fn && typeof fn.name === "string" ? fn.name : undefined;
      let argsStr = "";
      if (fn && fn.arguments !== undefined) {
        argsStr = typeof fn.arguments === "string" ? fn.arguments : safeStringify(fn.arguments);
      }
      const call: NormalizedMessage = {
        role: "tool_call",
        content: argsStr,
        tool_call_id: id,
      };
      if (name) call.tool_name = name;
      out.push(call);
    }
  }

  return out;
}

// ─── Codex Responses API (input[] items) ───────────────────────────────────

/**
 * 把 codex `input[]` 的一个 item 翻译成 5-role NormalizedMessage[]。
 *
 * item 类型清单 (docs/2026-08-07-codex-integration-plan.md §7.2 / agent-adapters/codex.ts):
 *   - {type:"message", role:"user"|"assistant"|"developer", content:[...]}
 *   - {type:"function_call", call_id, name, arguments}
 *   - {type:"function_call_output", call_id, output}
 *   - {type:"reasoning", encrypted_content}
 *
 * 映射:
 *   message.developer         → 丢弃 (等同 openai role=system, 不进 skill 语料)
 *   message.user              → role=user, content = 用户真键入文本 (走 codex adapter)
 *   message.assistant         → role=assistant, content = output_text 拼接
 *   function_call             → role=tool_call, tool_call_id, tool_name, content=arguments
 *   function_call_output      → role=tool_result, tool_call_id, content=output
 *   reasoning                 → 丢弃 (跟 anthropic thinking 对齐; 不进 skill 语料)
 *   其它未知 type              → 丢弃 (偏严不偏宽, 未来 codex 加新 item type 也不会误采)
 */
function convertCodexInputItem(item: RawMessage, agentSource: string): NormalizedMessage[] {
  const type = item.type;

  if (type === "message") {
    const role = item.role;
    // developer / system / 其它 role 一律丢
    if (role === "user") {
      return convertCodexUserMessage(item.content, agentSource);
    }
    if (role === "assistant") {
      return convertCodexAssistantMessage(item.content);
    }
    return [];
  }

  if (type === "function_call") {
    const id = typeof item.call_id === "string" ? item.call_id : "";
    const name = typeof item.name === "string" ? item.name : undefined;
    const argsRaw = item.arguments;
    const args = typeof argsRaw === "string" ? argsRaw : safeStringify(argsRaw);
    const call: NormalizedMessage = {
      role: "tool_call",
      content: args,
      tool_call_id: id,
    };
    if (name) call.tool_name = name;
    return [call];
  }

  if (type === "function_call_output") {
    const id = typeof item.call_id === "string" ? item.call_id : "";
    const outputRaw = item.output;
    const output = typeof outputRaw === "string" ? outputRaw : safeStringify(outputRaw);
    return [{
      role: "tool_result",
      content: output,
      tool_call_id: id,
    }];
  }

  // reasoning / 其它一律 drop
  return [];
}

/** codex user message 里 content 是 [{type:"input_text",text}, ...] */
function convertCodexUserMessage(content: unknown, agentSource: string): NormalizedMessage[] {
  // 优先复用 codex agent adapter 的 extractUserText —— 它跟 codexHandler
  // 里 `extractCodexUserText(input)` 是同一份实现 (agent-adapters/codex.ts:81),
  // 语义一致, 未来任何抽取规则升级只需改那一份。这里传单条 message 是包一层
  // adapter 期望的 [message] 数组即可 (它按 role=user 过滤)。
  //   注: adapter.extractUserText 期望的入参是完整 input[] 数组, 但内部只按
  //   条 iterate 挑最后一条 user; 传单条也能命中。
  const singleItem = { type: "message", role: "user", content } as Record<string, unknown>;
  const adapter = resolveAgentAdapter(agentSource);
  const text = adapter.extractUserText([singleItem]);
  if (typeof text === "string" && text.length > 0) {
    return [{ role: "user", content: text }];
  }
  return [];
}

/** codex assistant message 里 content 是 [{type:"output_text",text}, ...] */
function convertCodexAssistantMessage(content: unknown): NormalizedMessage[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ role: "assistant", content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    // codex assistant text 用 output_text; 兜底 text 万一 codex 用了别的写法
    if ((b.type === "output_text" || b.type === "text") && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  if (parts.length === 0) return [];
  return [{ role: "assistant", content: parts.join("\n") }];
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  return safeStringify(content);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    // e.g. BigInt / circular ref
    try {
      return String(v);
    } catch {
      return "";
    }
  }
}
