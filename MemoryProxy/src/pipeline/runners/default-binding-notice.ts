/**
 * Default-binding notice stream prepender.
 *
 * v3.3 user-session-default: 命中账户默认配置时, Proxy 需要让用户 100% 看到
 * 一段 markdown 绑定提示(✅ 当前 session 绑定默认配置 + Team/Agent/Task 三行)。
 *
 * ⚠️ 历史背景(两次失败方案的血泪):
 *   方案 1 (单行 Notice 让 LLM 转述)   → LLM 把 id 截断
 *   方案 2 (多行行号 Notice 让 LLM 复制) → LLM 直接忽略整段指令, 一字不念
 * 根因是 LLM 对事实性数据的"编造 / 润色 / 省略"倾向无法通过 prompt 消除。
 * 本模块是**方案 3**: Proxy 自己在响应流最前面拼一段 content delta,
 * 和 LLM 回复独立, 100% 到达用户。
 *
 * 协议适配: 本模块覆盖三种主流响应协议 ——
 *   - OpenAI /chat/completions (SSE + JSON)
 *   - OpenAI /v1/responses     (SSE + JSON)
 *   - Anthropic /v1/messages   (SSE + JSON)
 */

/**
 * 把一段 markdown 文本包成 **OpenAI SSE chat.completion.chunk** 的前缀 chunks,
 * 作为 `ReadableStream<Uint8Array>` 返回。模型 / 时间戳用通用占位(客户端不校验)。
 *
 * 产出的 SSE 片段形如:
 *   data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"}}]}\n\n
 *   data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"content":"<notice>\n\n"}}]}\n\n
 *
 * 注意: 不发 "finish_reason":"stop" —— 这只是**前缀**, 后面还要接 LLM 原始流;
 *       如果加 finish_reason 客户端会以为流结束, 砍掉后续 LLM 输出。
 */
function buildOpenAIPrefixSSE(notice: string, model: string): Uint8Array {
  const id = "chatcmpl-notice-" + Date.now().toString(36);
  const created = Math.floor(Date.now() / 1000);
  // 把 markdown 文本 + 两个换行(与 LLM 回复分开)作为第一个 content delta。
  const content = notice + "\n\n";
  const roleChunk = JSON.stringify({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });
  const contentChunk = JSON.stringify({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });
  // 两条 SSE event, 每条用 `data: {json}\n\n` 包起来。
  const text = `data: ${roleChunk}\n\n` + `data: ${contentChunk}\n\n`;
  return new TextEncoder().encode(text);
}

/**
 * 用 markdown 提示包装一个 OpenAI SSE 响应流 —— 把提示作为**前缀 chunks** 发出,
 * 然后原样接上游 LLM 的流。
 *
 * 空输入时返回 original stream, 不包装(无副作用)。
 */
export function prependNoticeToOpenAIStream(
  original: ReadableStream<Uint8Array>,
  notice: string | null,
  modelForChunk: string,
): ReadableStream<Uint8Array> {
  if (!notice) return original;
  const prefix = buildOpenAIPrefixSSE(notice, modelForChunk);
  // 用 TransformStream 的技巧: 第一次 pull 时先 enqueue prefix, 之后透传。
  const reader = original.getReader();
  let prefixEmitted = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!prefixEmitted) {
        prefixEmitted = true;
        controller.enqueue(prefix);
        return;
      }
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * 把 markdown 提示拼到**非流式** OpenAI chat/completions 响应的 message.content 前面。
 *
 * 输入是已解析的 JSON 响应对象(message/choices 结构), 原地修改 content。
 * 若结构异常(不符合 OpenAI 标准响应), 原样返回不动, 避免破坏客户端解析。
 */
export function prependNoticeToOpenAIJson(
  jsonResp: Record<string, unknown>,
  notice: string | null,
): Record<string, unknown> {
  if (!notice) return jsonResp;
  const choices = (jsonResp as any).choices;
  if (!Array.isArray(choices) || choices.length === 0) return jsonResp;
  const first = choices[0];
  const msg = first?.message;
  if (!msg || typeof msg !== "object") return jsonResp;
  const originalContent = typeof msg.content === "string" ? msg.content : "";
  msg.content = notice + "\n\n" + originalContent;
  return jsonResp;
}

/**
 * Anthropic `/v1/messages` 流式响应前缀.
 *
 * Anthropic SSE 事件序列(上游典型顺序):
 *   event: message_start           { message: {...} }
 *   event: content_block_start     { index: 0, content_block: {type:"text",...} }
 *   event: content_block_delta     { index: 0, delta: {type:"text_delta","text":"..."} }
 *   event: content_block_stop      { index: 0 }
 *   event: content_block_start     { index: 1, content_block: {type:"tool_use",...} }
 *   event: content_block_delta     { index: 1, delta: {type:"input_json_delta",...} }
 *   event: content_block_stop      { index: 1 }
 *   ...
 *   event: message_delta           { delta: {...}, usage: {...} }
 *   event: message_stop
 *
 * 策略: 在收到 `message_start` 之后、第一个 `content_block_start` 之前,
 * 插入**一个完整的 text block**(start + delta + stop, index=0), 并把上游所有
 * `content_block_*` 事件的 index 整体 +1。这样 Proxy 自造的 block 占 index=0,
 * 上游输出整体后移。
 *
 * index 改写只作用于 4 种事件(`content_block_start` / `content_block_delta` /
 * `content_block_stop` / `content_block_start`), 比 Responses API 的
 * `output_index` 改写更精确。消费 index 的客户端(claude-code)按 index 分桶写入
 * `content[index]`, index 单调递增且连续即可工作。
 *
 * 空输入时返回 original stream, 不改写(无副作用)。
 *
 * ⚠️ 已知限制:
 *   - 若上游在 `message_start` 之前就发了异常事件(error), 由于我们还没见到
 *     `message_start`, 不会插入 notice —— 这正是我们想要的 fail-open 行为。
 *   - 若上游完全没发 `message_start` 直接发 content(协议违规), 退化为**在首个
 *     content_block_start 前**插入, 保证不漏发。
 */
export function prependNoticeToAnthropicStream(
  original: ReadableStream<Uint8Array>,
  notice: string | null,
): ReadableStream<Uint8Array> {
  if (!notice) return original;

  const reader = original.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // 预制: 我们要插入的 3 个事件(都在 index=0)。
  const sse = (type: string, d: Record<string, unknown>): string =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const noticeEvents =
    sse("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    sse("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: notice + "\n\n" },
    }) +
    sse("content_block_stop", { index: 0 });

  let buffer = ""; // 跨 chunk 文本缓冲
  let noticeEmitted = false;
  let seenMessageStart = false;

  /**
   * 把一条 SSE event block 的 content_block_* 事件 index +1.
   * 只改 4 种事件: content_block_start / content_block_delta / content_block_stop
   * 其他事件(message_start / message_delta / message_stop / error / ping)原样透传。
   */
  function rewriteBlock(block: string): string {
    // 快速 gate: 不含 content_block_ 关键字直接返回。
    if (!block.includes("content_block_")) return block;
    const lines = block.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("data: ")) continue;
      try {
        const payload = JSON.parse(lines[i].slice(6));
        const t = payload.type;
        // 严格限定在 content_block_* 这 3 种事件上做 index 改写。
        if (
          (t === "content_block_start" ||
            t === "content_block_delta" ||
            t === "content_block_stop") &&
          typeof payload.index === "number"
        ) {
          payload.index += 1;
          lines[i] = "data: " + JSON.stringify(payload);
        }
      } catch {
        /* 非 JSON → 原样保留 */
      }
    }
    return lines.join("\n");
  }

  /** 从 event block 的 `event:` 行取 type;若无显式 event 行,回退从 data 行的 payload.type 取。 */
  function blockType(block: string): string | null {
    const m = block.match(/^event: ([^\n]+)/m);
    if (m) return m[1];
    // 回退: 从 data 行取 type
    const dm = block.match(/^data: (.+)$/m);
    if (dm) {
      try {
        const payload = JSON.parse(dm[1]);
        return typeof payload.type === "string" ? payload.type : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          // 收尾: buffer 里还有不完整的 block → 原样输出 (理论上不该发生,
          // 但万一发生要走已 emit 的 rewrite 规则, 保持前后一致)。
          if (buffer.length > 0) {
            const tail = noticeEmitted ? rewriteBlock(buffer) : buffer;
            controller.enqueue(encoder.encode(tail));
          }
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        // 按 "\n\n" 切分 SSE event。
        let idx: number;
        let out = "";
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx + 2); // 含结尾 "\n\n"
          buffer = buffer.slice(idx + 2);
          const type = blockType(block);
          // 时机 1: 在 message_start 之后插入(正常路径)。
          if (!noticeEmitted && seenMessageStart) {
            out += noticeEvents;
            noticeEmitted = true;
          }
          // 时机 2(容错): 直接看到 content_block_start 还没插过 → 立刻在它之前插。
          if (!noticeEmitted && type === "content_block_start") {
            out += noticeEvents;
            noticeEmitted = true;
          }
          // 已插过 notice → 后续所有事件走 content_block_* index +1 改写。
          out += noticeEmitted ? rewriteBlock(block) : block;
          if (type === "message_start") {
            seenMessageStart = true;
          }
        }
        if (out.length > 0) {
          controller.enqueue(encoder.encode(out));
          return;
        }
        // 这一轮没切出任何完整 event, 继续读。
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * 把 markdown 提示拼到**非流式** Anthropic `/v1/messages` 响应 content 前面。
 *
 * Anthropic 非流响应结构:
 *   {
 *     "id": "msg_...", "type": "message", "role": "assistant",
 *     "content": [
 *       {"type": "text", "text": "..."},
 *       {"type": "tool_use", "id":..., "name":..., "input":{...}},
 *       ...
 *     ],
 *     "usage": {...}
 *   }
 *
 * 策略: 在 `content[]` 最前面插入一个新的 text block。保留原 content 顺序;
 * tool_use 块不受影响。若结构异常(不符合 Anthropic 标准响应), 原样返回不动。
 */
export function prependNoticeToAnthropicJson(
  jsonResp: Record<string, unknown>,
  notice: string | null,
): Record<string, unknown> {
  if (!notice) return jsonResp;
  const content = (jsonResp as any).content;
  if (!Array.isArray(content)) return jsonResp;
  const noticeBlock = { type: "text", text: notice };
  (jsonResp as any).content = [noticeBlock, ...content];
  return jsonResp;
}

// ──────────────────────────────────────────────────────────────────────────────
// Responses API (/v1/responses, used by codex / workbuddy)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 把 markdown 提示拼到**非流式** Responses API 响应最前面。
 *
 * Responses API 的非流响应 body 结构:
 *   {
 *     "id": "...", "object": "response", ...
 *     "output": [
 *       {
 *         "id": "msg_...", "type": "message", "role": "assistant",
 *         "content": [{ "type": "output_text", "text": "...", "annotations": [] }],
 *         "status": "completed"
 *       },
 *       ...  // 可能跟着 function_call / reasoning 等
 *     ]
 *   }
 *
 * 策略: 把 notice 作为**新的 message item 插入到 output[0]** 前面(最前面)。
 * 这样对客户端是"收到两个 output message", 比在原 output[0].content 前拼字符串
 * 更干净 —— 原 message 的 token/annotation 保持不变, 不会把 Proxy 自造的
 * 文本算进 LLM 的 completion_tokens。
 *
 * 若结构异常(不符合 Responses API 标准响应), 原样返回不动, 避免破坏客户端解析。
 */
export function prependNoticeToResponsesJson(
  jsonResp: Record<string, unknown>,
  notice: string | null,
): Record<string, unknown> {
  if (!notice) return jsonResp;
  const output = (jsonResp as any).output;
  if (!Array.isArray(output)) return jsonResp;
  const noticeItem = {
    id: "msg_notice_" + Date.now().toString(36),
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: notice, annotations: [] }],
    status: "completed",
  };
  (jsonResp as any).output = [noticeItem, ...output];
  return jsonResp;
}

/**
 * 用 markdown 提示包装 Responses API **SSE 流**:
 *  - 在上游 `response.created` / `response.in_progress` 之后、
 *    `response.output_item.added` 之前, 插入**一组完整的 output message 事件**;
 *  - 为了避开"output_index 冲突"(上游 output 从 0 开始), 我们**改写上游所有
 *    事件的 output_index**: 原 i → i+1。这样 Proxy 自造的 message 占 index=0,
 *    上游输出整体后移。
 *
 * 事件序列(插在上游 response.in_progress 之后):
 *   response.output_item.added    { output_index: 0, item: {type:"message",...} }
 *   response.content_part.added   { output_index: 0, content_index: 0, part: {type:"output_text",...} }
 *   response.output_text.delta    { output_index: 0, content_index: 0, delta: "<notice>" }
 *   response.output_text.done     { output_index: 0, content_index: 0, text: "<notice>" }
 *   response.content_part.done    { output_index: 0, content_index: 0, part: {...} }
 *   response.output_item.done     { output_index: 0, item: {...} }
 *
 * 空输入时返回 original stream, 不改写(无副作用)。
 *
 * ⚠️ 已知限制:
 *   - 本实现**改写上游 output_index** —— 若上游在后续事件中引用 output_index
 *     (如 cfq-strip 做剥离判断), 索引变了可能影响其行为。本仓库的 cfq-strip
 *     观测使用 item_id 而非 output_index(见 cfq-strip.ts L513), 不受影响。
 *   - 若上游响应结构在未来变更(如新增别的"index 字段"), 需要同步更新改写规则。
 */
export function prependNoticeToResponsesStream(
  original: ReadableStream<Uint8Array>,
  notice: string | null,
): ReadableStream<Uint8Array> {
  if (!notice) return original;

  const reader = original.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const noticeItemId = "msg_notice_" + Date.now().toString(36);
  const sse = (type: string, d: Record<string, unknown>): string =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;

  // 预制: 我们要插入的 6 个事件(都在 output_index=0)。
  const noticeEvents = (
    sse("response.output_item.added", {
      output_index: 0,
      item: {
        id: noticeItemId, type: "message", role: "assistant",
        content: [], status: "in_progress",
      },
    }) +
    sse("response.content_part.added", {
      output_index: 0, item_id: noticeItemId, content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }) +
    sse("response.output_text.delta", {
      output_index: 0, item_id: noticeItemId, content_index: 0, delta: notice,
    }) +
    sse("response.output_text.done", {
      output_index: 0, item_id: noticeItemId, content_index: 0, text: notice,
    }) +
    sse("response.content_part.done", {
      output_index: 0, item_id: noticeItemId, content_index: 0,
      part: { type: "output_text", text: notice, annotations: [] },
    }) +
    sse("response.output_item.done", {
      output_index: 0,
      item: {
        id: noticeItemId, type: "message", role: "assistant",
        content: [{ type: "output_text", text: notice, annotations: [] }],
        status: "completed",
      },
    })
  );

  let buffer = ""; // 跨 chunk 文本缓冲 (SSE event 可能跨多个 Uint8Array)
  let noticeEmitted = false;
  let seenInProgress = false;

  /** 把一条 SSE event block 改写 output_index (如果它有的话)。 */
  function rewriteBlock(block: string): string {
    // 格式: "event: TYPE\ndata: JSON\n\n" 或仅 "data: JSON\n\n"
    // 简单做法: 用正则替换 "output_index": N → N+1。只替换数据体, 不碰 event 行。
    // 注意不能全局 replace, 因为可能有 nested json 里的其它 index(本协议下罕见)。
    const lines = block.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("data: ")) {
        try {
          const payload = JSON.parse(lines[i].slice(6));
          if (typeof payload.output_index === "number") {
            payload.output_index += 1;
            lines[i] = "data: " + JSON.stringify(payload);
          }
        } catch { /* 非 JSON → 原样保留 */ }
      }
    }
    return lines.join("\n");
  }

  /** 判定本 SSE event block 是哪个 type (若找不到视为未知, 不改)。 */
  function blockType(block: string): string | null {
    const m = block.match(/event: ([^\n]+)/);
    return m ? m[1] : null;
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          // 收尾: 如果 buffer 里还有不完整的 block, 原样输出 (理论上不该发生)。
          if (buffer.length > 0) controller.enqueue(encoder.encode(buffer));
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        // 按 "\n\n" 切分 SSE event (每个 event 以空行结尾)。
        let idx: number;
        let out = "";
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx + 2); // 含结尾 "\n\n"
          buffer = buffer.slice(idx + 2);
          const type = blockType(block);
          // 时机: 在 "response.in_progress" 之后、"response.output_item.added"
          // 之前插入 notice (若还没插过)。
          // 若上游先发了 output_item.added 但我们还没插, 说明错过了 in_progress
          // 时机 — 退而求其次直接在它之前插。
          if (!noticeEmitted && seenInProgress) {
            out += noticeEvents;
            noticeEmitted = true;
          }
          if (!noticeEmitted && type === "response.output_item.added") {
            out += noticeEvents;
            noticeEmitted = true;
          }
          // 已插过 notice 后, 需要改写上游所有带 output_index 的事件 (+1)。
          out += noticeEmitted ? rewriteBlock(block) : block;
          if (type === "response.in_progress") {
            seenInProgress = true;
          }
        }
        if (out.length > 0) {
          controller.enqueue(encoder.encode(out));
          return;
        }
        // 这一轮没切出任何完整 event, 继续读。
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
