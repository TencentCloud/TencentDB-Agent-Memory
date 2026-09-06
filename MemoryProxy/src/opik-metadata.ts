/**
 * Opik trace/span metadata 组装（调用链路 / 记忆注入 / 工具交互）。
 *
 * 纯函数、无 IO、无第三方依赖：
 * - 只允许明确声明的字段进入 metadata，避免把请求体/headers 原样塞入；
 * - 字符串长度封顶，防止超大 metadata 拖垮 Opik 存储；
 * - 工具交互摘要不复制消息正文，只保留工具名与结果条数。
 */

export interface MemoryInjectionContext {
  enabled?: boolean;
  injectorCount?: number;
  /** true = 会话/注入被旁路（无 conversationId、aux 请求或 headless）。 */
  skipped?: boolean;
}

export interface OpikTraceMetadataInput {
  agentSource?: string | null;
  protocol?: "openai" | "anthropic" | "responses";
  sessionKey?: string | null;
  conversationId?: string | null;
  spaceId?: string | null;
  userId?: string | null;
  model?: string | null;
  stream?: boolean;
  turnSeq?: number;
  requestPath?: string | null;
  memoryInjection?: MemoryInjectionContext;
}

function cap(v: unknown, max: number): string {
  const s = String(v ?? "").trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** 组装 trace/span 的 metadata：空/未定义字段一律不写入。 */
export function buildOpikTraceMetadata(input: OpikTraceMetadataInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const setStr = (key: string, v: unknown, max: number): void => {
    const s = cap(v, max);
    if (s) out[key] = s;
  };
  setStr("agent_source", input.agentSource, 32);
  setStr("protocol", input.protocol, 16);
  setStr("session_key", input.sessionKey, 128);
  setStr("conversation_id", input.conversationId, 128);
  setStr("space_id", input.spaceId, 64);
  setStr("user_id", input.userId, 64);
  setStr("model", input.model, 96);
  if (typeof input.stream === "boolean") out.stream = input.stream;
  if (typeof input.turnSeq === "number" && Number.isFinite(input.turnSeq)) {
    out.turn_seq = input.turnSeq;
  }
  setStr("request_path", input.requestPath, 256);

  const inj = input.memoryInjection;
  if (inj && (inj.enabled !== undefined || inj.injectorCount !== undefined || inj.skipped !== undefined)) {
    const m: Record<string, unknown> = {};
    if (typeof inj.enabled === "boolean") m.enabled = inj.enabled;
    if (typeof inj.injectorCount === "number" && inj.injectorCount >= 0) {
      m.injector_count = inj.injectorCount;
    }
    if (typeof inj.skipped === "boolean") m.skipped = inj.skipped;
    out.memory_injection = m;
  }
  return out;
}

export interface ToolInteractionSummary {
  toolCalls: string[];
  toolResults: number;
}

/** 从消息数组提取工具交互摘要（OpenAI chat / Anthropic 两种形态都兼容）。 */
export function summarizeToolInteraction(messages: unknown[]): ToolInteractionSummary {
  const names: string[] = [];
  const seen = new Set<string>();
  let toolResults = 0;
  const pushName = (name: unknown): void => {
    const n = typeof name === "string" ? name.trim() : "";
    if (n && !seen.has(n)) {
      seen.add(n);
      names.push(n);
    }
  };

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const msg = raw as Record<string, unknown>;
    const role = typeof msg.role === "string" ? msg.role : "";

    if (role === "assistant") {
      if (Array.isArray(msg.tool_calls)) {
        for (const tcRaw of msg.tool_calls) {
          const tc = (tcRaw ?? {}) as Record<string, unknown>;
          const fn = (tc.function ?? {}) as Record<string, unknown>;
          pushName(fn.name);
        }
      }
      if (Array.isArray(msg.content)) {
        for (const blockRaw of msg.content) {
          const block = (blockRaw ?? {}) as Record<string, unknown>;
          if (block.type === "tool_use") pushName(block.name);
        }
      }
      const legacy = (msg.function_call ?? {}) as Record<string, unknown>;
      if (legacy && typeof legacy.name === "string") pushName(legacy.name);
    }

    if (role === "tool") {
      toolResults += 1;
    } else if (Array.isArray(msg.content)) {
      for (const blockRaw of msg.content) {
        const block = (blockRaw ?? {}) as Record<string, unknown>;
        if (block.type === "tool_result") toolResults += 1;
      }
    }
  }
  return { toolCalls: names, toolResults };
}

/**
 * Responses wire（codex / workbuddy）的工具交互摘要：input[] 里的
 * `function_call`（工具名）与 `function_call_output`（结果条数）。
 * 与 Chat 版口径对齐：只保留工具名与条数，不复制消息正文。
 */
export function summarizeResponsesToolInteraction(
  input: unknown[],
): ToolInteractionSummary {
  const names: string[] = [];
  const seen = new Set<string>();
  let toolResults = 0;
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (item.type === "function_call") {
      const name = typeof item.name === "string" ? item.name.trim() : "";
      if (name && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    } else if (item.type === "function_call_output") {
      toolResults += 1;
    }
  }
  return { toolCalls: names, toolResults };
}
