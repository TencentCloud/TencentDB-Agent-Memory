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
  /** 配置里声明的注入器数量（配置级，不等于本轮实际执行的钩子数）。 */
  injectorCount?: number;
  /** true = 会话/注入被旁路（无 conversationId、aux 请求或 headless）。 */
  skipped?: boolean;
  /** 本轮实际执行的钩子数（含缓存命中与产出 0 block 的钩子）。 */
  hookCount?: number;
  /** 本轮注入进上下文的 block 总数。 */
  blockCount?: number;
  /** 本轮执行失败的钩子数（单钩子失败不阻断管线）。 */
  errorCount?: number;
  /** 逐钩子明细：hookId → 落点/block 数/缓存策略/是否出错。 */
  hooks?: Record<string, MemoryInjectionHookStat>;
}

/** 注入管线一次执行的单个钩子结果（与 pipeline 的 HookResult 结构兼容）。 */
export interface MemoryInjectionHookRun {
  hookId: string;
  point: string;
  blockCount: number;
  cacheStrategy?: string;
  error?: string;
}

/** 逐钩子明细的序列化形态（白名单字段，长度封顶）。 */
export interface MemoryInjectionHookStat {
  point: string;
  blockCount: number;
  cacheStrategy?: string;
  error?: boolean;
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

function toNonNegativeInt(v: unknown): number {
  const n = typeof v === "number" ? Math.trunc(v) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 组装 memory_injection 上下文：粗粒度（enabled / 配置注入器数 / skipped）
 * 加上本轮真实的逐钩子执行统计（hookCount / blockCount / errorCount / hooks）。
 *
 * hookRuns 为空/未跑管线时只落粗粒度字段；错误只记布尔位，错误原文留在
 * 结构化日志，避免把内部错误串进 Opik metadata。
 */
export function buildMemoryInjectionContext(input: {
  enabled: boolean;
  configuredInjectors: number;
  skipped: boolean;
  hookRuns?: MemoryInjectionHookRun[] | null;
}): MemoryInjectionContext {
  const ctx: MemoryInjectionContext = {
    enabled: input.enabled,
    injectorCount: input.configuredInjectors,
    skipped: input.skipped,
  };
  const runs = Array.isArray(input.hookRuns) ? input.hookRuns : [];
  if (runs.length === 0) return ctx;

  let blockCount = 0;
  let errorCount = 0;
  const hooks: Record<string, MemoryInjectionHookStat> = {};
  // 常规生产配置每轮 ≤ 8 个钩子；20 上限只是防御性护栏。
  for (const run of runs.slice(0, 20)) {
    const blocks = toNonNegativeInt(run.blockCount);
    blockCount += blocks;
    if (run.error) errorCount += 1;
    const hookId = cap(run.hookId, 64);
    if (!hookId) continue;
    const stat: MemoryInjectionHookStat = {
      point: cap(run.point, 32),
      blockCount: blocks,
    };
    const cacheStrategy = cap(run.cacheStrategy, 24);
    if (cacheStrategy) stat.cacheStrategy = cacheStrategy;
    if (run.error) stat.error = true;
    hooks[hookId] = stat;
  }

  ctx.hookCount = runs.length;
  ctx.blockCount = blockCount;
  ctx.errorCount = errorCount;
  if (Object.keys(hooks).length > 0) ctx.hooks = hooks;
  return ctx;
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
  if (
    inj &&
    (inj.enabled !== undefined ||
      inj.injectorCount !== undefined ||
      inj.skipped !== undefined ||
      inj.hookCount !== undefined ||
      inj.blockCount !== undefined ||
      inj.errorCount !== undefined ||
      inj.hooks !== undefined)
  ) {
    const m: Record<string, unknown> = {};
    if (typeof inj.enabled === "boolean") m.enabled = inj.enabled;
    if (typeof inj.injectorCount === "number" && inj.injectorCount >= 0) {
      m.injector_count = inj.injectorCount;
    }
    if (typeof inj.skipped === "boolean") m.skipped = inj.skipped;
    if (typeof inj.hookCount === "number" && inj.hookCount >= 0) {
      m.hook_count = inj.hookCount;
    }
    if (typeof inj.blockCount === "number" && inj.blockCount >= 0) {
      m.block_count = inj.blockCount;
    }
    if (typeof inj.errorCount === "number" && inj.errorCount >= 0) {
      m.error_count = inj.errorCount;
    }
    if (inj.hooks) {
      const hooksOut: Record<string, unknown> = {};
      for (const [hookId, stat] of Object.entries(inj.hooks)) {
        const statOut: Record<string, unknown> = {
          point: cap(stat.point, 32) || "unknown",
          block_count: toNonNegativeInt(stat.blockCount),
        };
        const cacheStrategy = cap(stat.cacheStrategy, 24);
        if (cacheStrategy) statOut.cache_strategy = cacheStrategy;
        if (stat.error === true) statOut.error = true;
        hooksOut[hookId] = statOut;
      }
      m.hooks = hooksOut;
    }
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

/**
 * 从 Responses 非流式 JSON 的 output[] 提取上报用摘要：
 * 文本（message.output_text/text）与工具调用名（function_call）。
 */
export function summarizeResponsesOutput(output: unknown[]): {
  text: string;
  toolCalls: string[];
} {
  const textParts: string[] = [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of output) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const block of item.content as unknown[]) {
        const b = block as Record<string, unknown> | null;
        if (
          b &&
          typeof b === "object" &&
          (b.type === "output_text" || b.type === "text") &&
          typeof b.text === "string" &&
          b.text
        ) {
          textParts.push(b.text);
        }
      }
    } else if (item.type === "function_call") {
      const name = typeof item.name === "string" ? item.name.trim() : "";
      if (name && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }
  return { text: textParts.join("\n"), toolCalls: names };
}
