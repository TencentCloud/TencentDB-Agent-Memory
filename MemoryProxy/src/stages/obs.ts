/**
 * 观测阶段：统一 4 个 handler 的 Opik/Langfuse 输入构造 + usage 提取。
 *
 * 消息形状用 `protocol`（shape）+ `agentSource` 参数区分：
 *   - "openai"    → handler.ts：debug 原样 / 走 flattenMessagesForOpik 压平；
 *   - "anthropic" → anthropicHandler：debug 前置 system / flattenAnthropicMessagesForOpik；
 *   - "responses" → codex（input 包一层对象 + instructions）/ workbuddy
 *     （input/instructions 组合策略），agentSource 区分两家的组合差异。
 *
 * usage 提取两个入口：
 *   - `extractUsageFromSseText(text)`：整段 SSE 文本扫描，合并 evt.usage 与
 *     evt.response.usage（原 common/sse-usage.ts，openai 的 last-usage 是
 *     其子集 —— include_usage 只在末帧带 usage，行为等价）；
 *   - `extractResponsesUsage(evt)`：responses SSE 单帧提取（codex/workbuddy
 *     流内共用，evt.response ?? evt 与原 workbuddy 语义一致）。
 */

/** Anthropic 顶层 system（string 或 content blocks 数组）拉平为纯文本。 */
export function stringifyAnthropicSystem(system: unknown): string {
  if (system === undefined || system === null) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    const parts: string[] = [];
    for (const block of system) {
      const b = block as Record<string, unknown>;
      if (b && b.type === "text" && typeof b.text === "string" && b.text) {
        parts.push(b.text);
      }
    }
    return parts.join("\n");
  }
  return JSON.stringify(system);
}

/**
 * Flatten OpenAI chat messages into Opik-friendly role+content shape
 * （content 数组压平为字符串；tool_calls / tool_result 逐条转 JSON）。
 * 原 handler.ts::flattenMessagesForOpik。
 */
export function flattenMessagesForOpik(messages: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const role = m.role as string;
    const content = m.content;
    if (typeof content === "string") {
      result.push(msg);
      continue;
    }
    if (!Array.isArray(content)) {
      if (role === "assistant" && Array.isArray(m.tool_calls)) {
        if (typeof content === "string" && content) {
          result.push({ role: "assistant", content });
        }
        for (const tc of m.tool_calls as unknown[]) {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          let argsStr = "";
          if (fn?.arguments) {
            argsStr = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments);
          }
          result.push({
            role: "assistant",
            content: JSON.stringify({ tool_call_id: t.id, tool_name: fn?.name ?? "unknown", arguments: argsStr }, null, 2),
          });
        }
        continue;
      }
      result.push(msg);
      continue;
    }
    if (role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          textParts.push(b.text as string);
        } else if (b.type === "tool_use") {
          toolCalls.push(b);
        } else if (b.type === "thinking" && b.thinking) {
          textParts.push(`[thinking] ${b.thinking as string}`);
        }
      }
      if (textParts.length > 0) {
        result.push({ role: "assistant", content: textParts.join("\n") });
      }
      for (const tc of toolCalls) {
        const t = tc as Record<string, unknown>;
        const inputStr = typeof t.input === "string" ? t.input : JSON.stringify(t.input);
        result.push({
          role: "assistant",
          content: JSON.stringify({ tool_call_id: t.id, tool_name: t.name, input: inputStr }, null, 2),
        });
      }
      const topLevelToolCalls = m.tool_calls;
      if (Array.isArray(topLevelToolCalls)) {
        for (const tc of topLevelToolCalls) {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          let argsStr = "";
          if (fn?.arguments) {
            argsStr = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments);
          }
          result.push({
            role: "assistant",
            content: JSON.stringify({ tool_call_id: t.id, tool_name: fn?.name ?? "unknown", arguments: argsStr }, null, 2),
          });
        }
      }
    } else if (role === "user") {
      const textParts: string[] = [];
      const toolResults: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          textParts.push(b.text as string);
        } else if (b.type === "tool_result") {
          toolResults.push(b);
        } else {
          textParts.push(JSON.stringify(b));
        }
      }
      if (textParts.length > 0) {
        result.push({ role: "user", content: textParts.join("\n") });
      }
      for (const tr of toolResults) {
        const t = tr as Record<string, unknown>;
        let resultContent: string;
        if (typeof t.content === "string") {
          resultContent = t.content;
        } else if (Array.isArray(t.content)) {
          resultContent = (t.content as Record<string, unknown>[])
            .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
            .join("\n");
        } else {
          resultContent = JSON.stringify(t.content);
        }
        result.push({
          role: "tool",
          content: JSON.stringify({ tool_call_id: t.tool_use_id, is_error: t.is_error ?? false, result: resultContent }, null, 2),
        });
      }
    } else {
      const merged = content.map((b: unknown) => {
        const block = b as Record<string, unknown>;
        if (block.type === "text") return block.text as string;
        return JSON.stringify(block);
      }).join("\n");
      result.push({ role, content: merged });
    }
  }
  return result;
}

/**
 * Flatten Anthropic messages for Opik / Langfuse display。
 * system 单独前置为 {role:"system"}；content blocks 按 text / tool_use /
 * thinking / tool_result 展开。原 anthropicHandler.ts::flattenAnthropicMessagesForOpik。
 */
export function flattenAnthropicMessagesForOpik(
  messages: unknown[],
  system?: unknown,
): unknown[] {
  const result: unknown[] = [];
  const systemText = stringifyAnthropicSystem(system);
  if (systemText) {
    result.push({ role: "system", content: systemText });
  }
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const role = m.role as string;
    const content = m.content;

    if (typeof content === "string") {
      result.push({ role, content });
      continue;
    }

    if (!Array.isArray(content)) {
      result.push({ role, content: JSON.stringify(content) });
      continue;
    }

    if (role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          textParts.push(b.text as string);
        } else if (b.type === "tool_use") {
          toolCalls.push(b);
        } else if (b.type === "thinking" && b.thinking) {
          textParts.push(`[thinking] ${(b.thinking as string).slice(0, 200)}`);
        }
      }
      if (textParts.length > 0) {
        result.push({ role: "assistant", content: textParts.join("\n") });
      }
      for (const tc of toolCalls) {
        const t = tc as Record<string, unknown>;
        const inputStr = typeof t.input === "string" ? t.input : JSON.stringify(t.input);
        result.push({
          role: "assistant",
          content: JSON.stringify({ tool_call_id: t.id, tool_name: t.name, input: inputStr }, null, 2),
        });
      }
    } else if (role === "user") {
      const textParts: string[] = [];
      const toolResults: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          textParts.push(b.text as string);
        } else if (b.type === "tool_result") {
          toolResults.push(b);
        } else {
          textParts.push(JSON.stringify(b));
        }
      }
      if (textParts.length > 0) {
        result.push({ role: "user", content: textParts.join("\n") });
      }
      for (const tr of toolResults) {
        const t = tr as Record<string, unknown>;
        let resultContent: string;
        if (typeof t.content === "string") {
          resultContent = t.content;
        } else if (Array.isArray(t.content)) {
          resultContent = (t.content as Record<string, unknown>[])
            .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
            .join("\n");
        } else {
          resultContent = JSON.stringify(t.content);
        }
        result.push({
          role: "tool",
          content: JSON.stringify({ tool_call_id: t.tool_use_id, is_error: t.is_error ?? false, result: resultContent }, null, 2),
        });
      }
    } else {
      const merged = content.map((b: unknown) => {
        const block = b as Record<string, unknown>;
        if (block.type === "text") return block.text as string;
        return JSON.stringify(block);
      }).join("\n");
      result.push({ role, content: merged });
    }
  }
  return result;
}

/** buildObsInput 参数。 */
export interface BuildObsInputOptions {
  protocol: "openai" | "anthropic" | "responses";
  /** responses 用：codex 包对象 + instructions；workbuddy 组合策略。 */
  agentSource?: string;
  /** responses 用：body.input / body.instructions 来源。 */
  body?: Record<string, unknown>;
  /** openai / anthropic 用：body.messages。 */
  messages?: unknown[];
  /** anthropic 用：body.system（顶层 system 字段）。 */
  system?: unknown;
  /** langfuse.debug === true。 */
  debug?: boolean;
  /** openai 非 debug 的压平 fallback（默认 flattenMessagesForOpik）。 */
  flatten?: (messages: unknown[]) => unknown[];
}

/** responses 形状的 Langfuse input 组合（codex / workbuddy 差异收敛）。 */
function buildResponsesObsInput(
  body: Record<string, unknown>,
  agentSource?: string,
): unknown {
  const hasInput = Array.isArray(body.input);
  const hasInstructions =
    typeof body.instructions === "string" && (body.instructions as string).length > 0;
  if (!hasInput && !hasInstructions) return undefined;
  if (agentSource === "codex") {
    // codex 原行为：input 恒包一层对象，instructions 可选带上。
    const out: Record<string, unknown> = { input: body.input };
    if (hasInstructions) out.instructions = body.instructions;
    return out;
  }
  // workbuddy 原行为：都有 → { input, instructions }；仅 input → 直接返回 input。
  if (hasInput && hasInstructions) {
    return { input: body.input, instructions: body.instructions };
  }
  return hasInput ? body.input : { instructions: body.instructions };
}

/**
 * 统一 Langfuse/Opik 输入构造（4 个 handler 的原 builder 收敛）。
 */
export function buildObsInput(opts: BuildObsInputOptions): unknown {
  if (opts.protocol === "responses") {
    return buildResponsesObsInput(opts.body ?? {}, opts.agentSource);
  }
  if (opts.protocol === "anthropic") {
    const { messages, system, debug } = opts;
    if (debug) {
      // 保留原生结构：system 非空时前置一条合成 system 消息，顺序与其它消费方一致。
      const out: unknown[] = [];
      if (system !== undefined && system !== null && system !== "") {
        out.push({ role: "system", content: system });
      }
      return out.concat(messages ?? []);
    }
    return flattenAnthropicMessagesForOpik(messages ?? [], system);
  }
  // openai
  if (opts.debug) return opts.messages ?? [];
  return (opts.flatten ?? flattenMessagesForOpik)(opts.messages ?? []);
}

/**
 * 从 SSE 文本提取 usage（已知边界修复）：扫描所有 `data:` 帧，合并 usage 字段
 * （Anthropic `message_delta.usage` / Responses `response.completed.usage`）。
 * 原 common/sse-usage.ts::extractUsageFromSseText。
 */
export function extractUsageFromSseText(text: string): Record<string, unknown> | null {
  if (!text || !text.includes("data:")) return null;
  const merged: Record<string, unknown> = {};
  let found = false;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const evt = JSON.parse(payload) as Record<string, unknown>;
      const usage =
        (evt.usage as Record<string, unknown> | undefined) ??
        (evt.response as { usage?: Record<string, unknown> } | undefined)?.usage;
      if (usage && typeof usage === "object") {
        Object.assign(merged, usage);
        found = true;
      }
    } catch {
      /* 忽略非 JSON 帧 */
    }
  }
  return found ? merged : null;
}

/** responses SSE 单帧 usage 提取（codex/workbuddy 流内共用；evt.response ?? evt）。 */
export function extractResponsesUsage(evt: Record<string, unknown>): Record<string, unknown> | null {
  const resp = (evt.response ?? evt) as Record<string, unknown> | undefined;
  if (resp?.usage && typeof resp.usage === "object") {
    return resp.usage as Record<string, unknown>;
  }
  return null;
}
