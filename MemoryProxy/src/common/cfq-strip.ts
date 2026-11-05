/**
 * 回给 agent 之前，把注入的 `context_focus_question` 从 tool_call 参数里摘掉。
 *
 * 为什么要摘：注入这个字段是为了拿到压缩线索，线索在响应 tap 阶段就已经进了 Redis
 * 侧信道，下一轮由 backfill 注回**转发给上游**的请求体——agent 全程不需要看见它。
 * 而它看见了会出事：客户端按自己的 tool schema 校验参数，多出来的字段被判成
 * `InputValidationError: An unexpected parameter ... was provided`，工具拒绝执行。
 *
 * ── 流式为什么要「延后一帧」而不是直接删 ──────────────────────────────────
 * tool_call 的参数在 SSE 里是一串 JSON 分片（Anthropic 的 `input_json_delta`、
 * Responses 的 `function_call_arguments.delta`），单个分片可能断在 key 名中间、
 * 转义符中间，没法逐片删 key——必须等整串拼完。
 *
 * 但也不能「攒着不发、最后补一个新事件」：Responses 的事件带 `sequence_number`，
 * 凭空插帧会让序号对不上。所以这里始终**扣住最后一个分片事件**：先到的分片照常发出
 * 去、只是把载荷换成空串，等参数收齐了再把扣住的那一帧连同完整的清理结果发出去。
 * 客户端做的是字符串拼接，`"" + "" + 完整串` 与原来等价，而事件数量、顺序、序号、
 * `item_id` 全部原样保留。
 *
 * 代价是工具参数不再逐字出现在客户端 UI 上，而是在该块结束时整体出现。功能无影响：
 * 客户端本来也要等 JSON 完整才能执行工具。
 *
 * OpenAI Chat 的 chunk 虽然没有序号，插帧看似安全，但客户端会按自己认得的形状校验
 * tool_call（CodeBuddy 要求 `type: "function"`），补发的 chunk 无论带不带这些字段
 * 都可能被判非法——带了又可能被按字符串累加成 `"functionfunction"`。所以它也走扣帧。
 *
 * 所有解析失败一律原样透传：坏掉的上游响应应该原样暴露给客户端，不该在这里被二次加工。
 */

// 字段名归压缩扩展所有，宿主只经由 adapter 调用，扩展不在时整条链路自动退化为
// 空操作——扩展不在就没有注入，也就没有要摘的东西。
import {
  hasInjectedToolCleanup,
  shouldStripInjectedTool,
  stripInjectedToolArguments as stripCfqFromArguments,
  stripInjectedToolInput as stripCfqFromInput,
} from "../request-prepare-adapter.js";

export type CfqStripProtocol = "anthropic" | "openai" | "responses";
type ShouldStripTool = (toolName: string | undefined) => boolean;
/**
 * Handlers pass their opaque preparation stats; focused unit tests/direct
 * callers may pass the exact injected tool-name set.
 */
export type CfqStripSelection =
  | Record<string, unknown>
  | ReadonlySet<string>
  | null
  | undefined;

export interface CfqStripSummary {
  protocol: CfqStripProtocol;
  stream: boolean;
  strippedCount: number;
  toolNames: string[];
  /**
   * Tools that this request extended *and* the model actually called, so a call
   * carrying no injected field is a real omission rather than a turn the
   * injection never applied to.
   *
   * Without this, "stripped nothing" is ambiguous: a plain prose answer, a turn
   * that only called un-extended tools, and a model that ignored the field all
   * produce a count of zero. Only the last one is worth a warning.
   */
  eligibleTools: string[];
}

export type CfqStripObserver = (summary: CfqStripSummary) => void;
type MarkStripped = (identity: string, toolName: string) => void;

export function formatCfqStripSummary(summary: CfqStripSummary): string {
  return `success=true field=context_focus_question protocol=${summary.protocol} stream=${summary.stream} calls=${summary.strippedCount} tools=${summary.toolNames.join(",")}`;
}

/**
 * Observer that reports a successful strip and flags the one case that silently
 * costs compression later: the model called a tool we extended, but left the
 * injected field out, so there is nothing to carry over to the next turn.
 *
 * Deliberately narrower than the response-side `CFQ_NOT_PRODUCED` check, which
 * sees every tool call but not which of them were extended. This one knows the
 * extension set exactly, so it does not blame the model for calls that were
 * never asked to carry the field.
 *
 * Takes the pipeline logger itself rather than a bare callback: every call site
 * has one, and the structural `{ info }` shape keeps tests free to pass a stub.
 */
export function createCfqStripObserver(
  logger: { info(stage: string, detail: string): void },
): CfqStripObserver {
  return (summary) => {
    if (summary.strippedCount > 0) {
      logger.info("CFQ_STRIP_SUCCESS", formatCfqStripSummary(summary));
      return;
    }
    // Nothing stripped and nothing eligible: injection simply did not apply to
    // this turn. Staying quiet keeps the warning meaningful.
    if (summary.eligibleTools.length === 0) return;
    logger.info(
      "CFQ_INJECTED_NOT_FILLED",
      `⚠️ protocol=${summary.protocol} stream=${summary.stream} ` +
        `eligible_tools=${summary.eligibleTools.join(",")} stripped=0 — the model ` +
        `called these extended tool(s) without populating the injected field, so ` +
        `the side channel stores nothing and the next turn falls back to no_cfq`,
    );
  };
}

function createStripTracker(
  protocol: CfqStripProtocol,
  stream: boolean,
  observer: CfqStripObserver | undefined,
): { mark: MarkStripped; markEligible: (toolName: string) => void; report: () => void } {
  const identities = new Set<string>();
  const toolNames = new Set<string>();
  const eligibleTools = new Set<string>();
  return {
    mark(identity, toolName) {
      identities.add(identity);
      toolNames.add(toolName);
    },
    markEligible(toolName) {
      eligibleTools.add(toolName);
    },
    report() {
      if (!observer) return;
      // Report even when nothing was stripped: the observer needs the eligible
      // set to tell an omission from an inapplicable turn.
      if (identities.size === 0 && eligibleTools.size === 0) return;
      observer({
        protocol,
        stream,
        strippedCount: identities.size,
        toolNames: [...toolNames],
        eligibleTools: [...eligibleTools],
      });
    },
  };
}

function selectionHasWork(selection: CfqStripSelection): boolean {
  return selection instanceof Set
    ? selection.size > 0
    : hasInjectedToolCleanup(selection as Record<string, unknown> | null | undefined);
}

function selectionMatches(selection: CfqStripSelection, toolName: string | undefined): boolean {
  if (!toolName) return false;
  return selection instanceof Set
    ? selection.has(toolName)
    : shouldStripInjectedTool(
        selection as Record<string, unknown> | null | undefined,
        toolName,
      );
}

/**
 * Wrap the eligibility test so every match is recorded on the way through.
 *
 * The strippers ask this question at exactly the points where a tool call is
 * identified, which is also the only place that knows a call was eligible even
 * though it turned out to carry nothing. Recording here keeps that knowledge
 * without threading an extra callback through all three protocol strippers.
 */
function trackEligible(
  selection: CfqStripSelection,
  markEligible: (toolName: string) => void,
): ShouldStripTool {
  return (toolName) => {
    if (!selectionMatches(selection, toolName)) return false;
    markEligible(toolName!);
    return true;
  };
}

// ── SSE 帧处理 ───────────────────────────────────────────────────────────────

/**
 * 一个 SSE 事件块。`event:` 等非 data 行原样保留——Responses 客户端靠 `event:` 头
 * 分派，重建时动了它就全乱了。
 */
interface SseFrame {
  lines: string[];
  dataLineIdx: number;
  dataStr: string;
}

function parseFrame(block: string): SseFrame | null {
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("data: ")) return { lines, dataLineIdx: i, dataStr: line.slice(6) };
    if (line.startsWith("data:")) return { lines, dataLineIdx: i, dataStr: line.slice(5) };
  }
  return null;
}

/** 用新的 data 载荷重建事件块（含结尾空行）。 */
function rebuildFrame(frame: SseFrame, data: unknown): string {
  const lines = frame.lines.slice();
  lines[frame.dataLineIdx] = `data: ${JSON.stringify(data)}`;
  return `${lines.join("\n")}\n\n`;
}

// ── 非流式 ───────────────────────────────────────────────────────────────────

/** Anthropic `content[]` 里的 tool_use 块。 */
function stripAnthropicBody(
  body: Record<string, unknown>,
  shouldStrip: ShouldStripTool,
  mark: MarkStripped,
): boolean {
  const content = body.content;
  if (!Array.isArray(content)) return false;
  let changed = false;
  for (const block of content) {
    const b = block as Record<string, unknown> | null;
    if (
      b?.type === "tool_use" &&
      shouldStrip(typeof b.name === "string" ? b.name : undefined) &&
      stripCfqFromInput(b.input)
    ) {
      changed = true;
      mark(typeof b.id === "string" ? b.id : `anthropic:${content.indexOf(block)}`, b.name as string);
    }
  }
  return changed;
}

/** OpenAI Chat `choices[].message.tool_calls[]`。 */
function stripChatBody(
  body: Record<string, unknown>,
  shouldStrip: ShouldStripTool,
  mark: MarkStripped,
): boolean {
  const choices = body.choices;
  if (!Array.isArray(choices)) return false;
  let changed = false;
  for (const choice of choices) {
    const message = (choice as Record<string, unknown> | null)?.message as
      | Record<string, unknown>
      | undefined;
    const toolCalls = message?.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      const fn = (tc as Record<string, unknown> | null)?.function as
        | Record<string, unknown>
        | undefined;
      if (!shouldStrip(typeof fn?.name === "string" ? fn.name : undefined)) continue;
      if (typeof fn?.arguments !== "string") continue;
      const cleaned = stripCfqFromArguments(fn.arguments);
      if (cleaned !== null) {
        fn.arguments = cleaned;
        changed = true;
        const toolName = fn.name as string;
        const toolId = (tc as Record<string, unknown>).id;
        mark(typeof toolId === "string" ? toolId : `openai:${toolName}`, toolName);
      }
    }
  }
  return changed;
}

/** Responses `output[]` 里的 function_call item。 */
function stripResponsesOutput(
  output: unknown,
  shouldStrip: ShouldStripTool,
  mark: MarkStripped,
): boolean {
  if (!Array.isArray(output)) return false;
  let changed = false;
  for (const item of output) {
    const it = item as Record<string, unknown> | null;
    if (it?.type !== "function_call" || typeof it.arguments !== "string") continue;
    if (!shouldStrip(typeof it.name === "string" ? it.name : undefined)) continue;
    const cleaned = stripCfqFromArguments(it.arguments);
    if (cleaned !== null) {
      it.arguments = cleaned;
      changed = true;
      const toolName = it.name as string;
      const identity =
        typeof it.id === "string"
          ? it.id
          : typeof it.call_id === "string"
            ? it.call_id
            : `responses:${toolName}`;
      mark(identity, toolName);
    }
  }
  return changed;
}

function stripResponsesBody(
  body: Record<string, unknown>,
  shouldStrip: ShouldStripTool,
  mark: MarkStripped,
): boolean {
  // 顶层 `output[]`，以及 `response.output[]`（SSE 终帧与部分非流式包装）。
  const nested = body.response as Record<string, unknown> | undefined;
  const a = stripResponsesOutput(body.output, shouldStrip, mark);
  const b = nested ? stripResponsesOutput(nested.output, shouldStrip, mark) : false;
  return a || b;
}

/**
 * 非流式响应体剥离。无改动时返回原始字符串，避免无意义的重新序列化。
 *
 * 必须在 `notifyUpstreamResponse` 之后调用——侧信道要的是模型原始输出。
 */
export function stripCfqFromResponseText(
  protocol: CfqStripProtocol,
  text: string,
  selection: CfqStripSelection,
  observer?: CfqStripObserver,
): string {
  if (!text) return text;
  if (!selectionHasWork(selection)) return text;
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return text;
    body = parsed as Record<string, unknown>;
  } catch {
    return text;
  }
  const tracker = createStripTracker(protocol, false, observer);
  const shouldStrip = trackEligible(selection, tracker.markEligible);
  const changed =
    protocol === "anthropic"
      ? stripAnthropicBody(body, shouldStrip, tracker.mark)
      : protocol === "openai"
        ? stripChatBody(body, shouldStrip, tracker.mark)
        : stripResponsesBody(body, shouldStrip, tracker.mark);
  tracker.report();
  return changed ? JSON.stringify(body) : text;
}

// ── 流式 ─────────────────────────────────────────────────────────────────────

/** 被扣住的分片事件：等参数收齐后带着完整载荷补发。 */
interface HeldDelta {
  frame: SseFrame;
  evt: Record<string, unknown>;
}

type Emit = (chunk: string) => void;

/**
 * 一个协议的剥离器。`flush` 负责在流结束时补发仍被扣住的帧——上游中途断掉时，
 * 扣住的那一帧如果跟着一起丢了，客户端拿到的就是个空参数的 tool_call。
 */
interface Stripper {
  onBlock: (block: string) => void;
  flush: () => void;
}

/**
 * Anthropic：按 block index 扣帧，`content_block_stop` 时结算。
 */
function makeAnthropicStripper(
  emit: Emit,
  shouldStrip: ShouldStripTool,
  mark: MarkStripped,
): Stripper {
  const toolBlocks = new Set<number>();
  const buf = new Map<number, string>();
  const held = new Map<number, HeldDelta>();
  const toolMeta = new Map<number, { id: string; name: string }>();

  /** 补发扣住的那一帧，载荷换成 `partialJson`。 */
  const release = (index: number, partialJson: string): void => {
    const h = held.get(index);
    if (!h) return;
    held.delete(index);
    const delta = h.evt.delta as Record<string, unknown>;
    delta.partial_json = partialJson;
    emit(rebuildFrame(h.frame, h.evt));
  };

  const onBlock = (block: string): void => {
    const frame = parseFrame(block);
    if (!frame || !frame.dataStr || frame.dataStr === "[DONE]") {
      emit(`${block}\n\n`);
      return;
    }

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(frame.dataStr) as Record<string, unknown>;
    } catch {
      emit(`${block}\n\n`);
      return;
    }

    const index = typeof evt.index === "number" ? evt.index : -1;
    const type = evt.type;

    if (type === "content_block_start") {
      const cb = evt.content_block as Record<string, unknown> | undefined;
      const toolName = typeof cb?.name === "string" ? cb.name : undefined;
      if (cb?.type === "tool_use" && index >= 0 && shouldStrip(toolName)) {
        toolBlocks.add(index);
        buf.set(index, "");
        toolMeta.set(index, {
          id: typeof cb.id === "string" ? cb.id : `anthropic:${index}`,
          name: toolName!,
        });
        // `input` 此时通常是 {}，但上游偶尔会直接带上完整参数。
        if (stripCfqFromInput(cb.input)) {
          const meta = toolMeta.get(index)!;
          mark(meta.id, meta.name);
          emit(rebuildFrame(frame, evt));
          return;
        }
      }
      emit(`${block}\n\n`);
      return;
    }

    if (type === "content_block_delta" && toolBlocks.has(index)) {
      const delta = evt.delta as Record<string, unknown> | undefined;
      if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        buf.set(index, (buf.get(index) ?? "") + delta.partial_json);
        release(index, ""); // 让位：先到的分片发空串
        held.set(index, { frame, evt });
        return;
      }
      emit(`${block}\n\n`);
      return;
    }

    if (type === "content_block_stop" && toolBlocks.has(index)) {
      const raw = buf.get(index) ?? "";
      const cleaned = stripCfqFromArguments(raw);
      if (cleaned !== null) {
        const meta = toolMeta.get(index);
        if (meta) mark(meta.id, meta.name);
      }
      release(index, cleaned ?? raw);
      toolBlocks.delete(index);
      buf.delete(index);
      toolMeta.delete(index);
      emit(`${block}\n\n`);
      return;
    }

    emit(`${block}\n\n`);
  };

  const flush = (): void => {
    for (const index of [...held.keys()]) {
      const raw = buf.get(index) ?? "";
      const cleaned = stripCfqFromArguments(raw);
      if (cleaned !== null) {
        const meta = toolMeta.get(index);
        if (meta) mark(meta.id, meta.name);
      }
      release(index, cleaned ?? raw);
    }
  };

  return { onBlock, flush };
}

/**
 * Responses：按 item_id 扣帧，`function_call_arguments.done` 时结算。
 * 终帧里的 `output[]` 也要清理——客户端可能只认终帧那份完整 item。
 *
 * 三个已知缺口，当前客户端（codex）未暴露问题，暂不处理：
 *   - 扣住的帧要等同一 item 的下一片才发，夹在中间的事件会插到它前面，
 *     `sequence_number` 因此非单调（并行 function_call 交错时尤其明显）。
 *   - 剥离资格只在 `output_item.added` 带 `name` 时注册；`name` 延后给出的
 *     实现里，参数分片会带着 CFQ 原样发出，只有终帧那份被清理。
 *   - 终态事件只覆盖 `completed` / `incomplete`，`response.failed` 里的
 *     `output[]` 不会被清理。
 */
function makeResponsesStripper(
  emit: Emit,
  shouldStrip: ShouldStripTool,
  mark: MarkStripped,
): Stripper {
  const buf = new Map<string, string>();
  const held = new Map<string, HeldDelta>();
  const eligibleItemIds = new Set<string>();
  const toolMeta = new Map<string, { name: string }>();

  const release = (itemId: string, deltaText: string): void => {
    const h = held.get(itemId);
    if (!h) return;
    held.delete(itemId);
    h.evt.delta = deltaText;
    emit(rebuildFrame(h.frame, h.evt));
  };

  const onBlock = (block: string): void => {
    const frame = parseFrame(block);
    if (!frame || !frame.dataStr || frame.dataStr === "[DONE]") {
      emit(`${block}\n\n`);
      return;
    }

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(frame.dataStr) as Record<string, unknown>;
    } catch {
      emit(`${block}\n\n`);
      return;
    }

    const type = evt.type;
    const itemId = typeof evt.item_id === "string" ? evt.item_id : "";

    if (type === "response.output_item.added") {
      const item = evt.item as Record<string, unknown> | undefined;
      const addedId = typeof item?.id === "string" ? item.id : "";
      const toolName = typeof item?.name === "string" ? item.name : undefined;
      if (item?.type === "function_call" && addedId && shouldStrip(toolName)) {
        eligibleItemIds.add(addedId);
        toolMeta.set(addedId, { name: toolName! });
        if (stripResponsesOutput([item], shouldStrip, mark)) {
          emit(rebuildFrame(frame, evt));
          return;
        }
      }
    } else if (
      type === "response.function_call_arguments.delta" &&
      itemId &&
      eligibleItemIds.has(itemId)
    ) {
      if (typeof evt.delta === "string") {
        buf.set(itemId, (buf.get(itemId) ?? "") + evt.delta);
        release(itemId, "");
        held.set(itemId, { frame, evt });
        return;
      }
    } else if (
      type === "response.function_call_arguments.done" &&
      itemId &&
      eligibleItemIds.has(itemId)
    ) {
      // `.done` 带的是权威全量参数；拿不到才退回自己拼的。
      const raw = typeof evt.arguments === "string" ? evt.arguments : (buf.get(itemId) ?? "");
      const stripped = stripCfqFromArguments(raw);
      const cleaned = stripped ?? raw;
      if (stripped !== null) {
        const meta = toolMeta.get(itemId);
        if (meta) mark(itemId, meta.name);
      }
      release(itemId, cleaned);
      buf.delete(itemId);
      if (typeof evt.arguments === "string" && evt.arguments !== cleaned) {
        evt.arguments = cleaned;
        emit(rebuildFrame(frame, evt));
        return;
      }
    } else if (type === "response.output_item.done") {
      if (stripResponsesOutput([evt.item], shouldStrip, mark)) {
        emit(rebuildFrame(frame, evt));
        return;
      }
    } else if (type === "response.completed" || type === "response.incomplete") {
      const resp = evt.response as Record<string, unknown> | undefined;
      if (resp && stripResponsesOutput(resp.output, shouldStrip, mark)) {
        emit(rebuildFrame(frame, evt));
        return;
      }
    }

    emit(`${block}\n\n`);
  };

  const flush = (): void => {
    for (const itemId of [...held.keys()]) {
      const raw = buf.get(itemId) ?? "";
      const cleaned = stripCfqFromArguments(raw);
      const meta = toolMeta.get(itemId);
      if (cleaned !== null && meta) mark(itemId, meta.name);
      release(itemId, cleaned ?? raw);
    }
  };

  return { onBlock, flush };
}

/**
 * OpenAI Chat：按 `choice:tool_call` 序号扣帧，收到 finish chunk 时结算。
 *
 * 跟另外两个协议同一套路（见文件头注释）：不凭空造 chunk，只改扣住那一帧里
 * `function.arguments` 的内容。chat 的分片 tool_call 条目允许只带 `index` +
 * `function.arguments`，但客户端对「自己没见过的形状」很挑剔（CodeBuddy 会按
 * `type` 校验 tool_call），补发出来的 chunk 少一个字段就会被判非法；扣帧则保证
 * 客户端收到的每一帧都跟上游原样一致。
 */
function makeChatStripper(
  emit: Emit,
  shouldStrip: ShouldStripTool,
  mark: MarkStripped,
): Stripper {
  /** 扣住的 chat chunk：一帧里可能同时承载多个 tool_call 的分片。 */
  interface HeldChunk {
    frame: SseFrame;
    evt: Record<string, unknown>;
    /** key -> 该帧里承载参数的 `function` 对象，结算时往里写清理后的全量参数。 */
    slots: Map<string, Record<string, unknown>>;
  }

  const buf = new Map<string, string>();
  const eligible = new Set<string>();
  const toolNameOf = new Map<string, string>();
  const toolIdOf = new Map<string, string>();
  const heldOrder: HeldChunk[] = [];
  const heldByKey = new Map<string, HeldChunk>();

  const emitHeld = (held: HeldChunk): void => {
    const at = heldOrder.indexOf(held);
    if (at >= 0) heldOrder.splice(at, 1);
    for (const key of held.slots.keys()) {
      if (heldByKey.get(key) === held) heldByKey.delete(key);
    }
    emit(rebuildFrame(held.frame, held.evt));
  };

  /** 把收齐的参数清理后写回扣住的那个分片。 */
  const settle = (key: string, fn: Record<string, unknown>): void => {
    const raw = buf.get(key) ?? "";
    const cleaned = stripCfqFromArguments(raw);
    if (cleaned !== null) {
      const toolName = toolNameOf.get(key);
      if (toolName) mark(toolIdOf.get(key) ?? key, toolName);
    }
    fn.arguments = cleaned ?? raw;
    buf.delete(key);
    eligible.delete(key);
  };

  const flush = (): void => {
    for (const held of [...heldOrder]) {
      for (const [key, fn] of held.slots) settle(key, fn);
      emitHeld(held);
    }
  };

  const onBlock = (block: string): void => {
    const frame = parseFrame(block);
    if (!frame || !frame.dataStr) {
      emit(`${block}\n\n`);
      return;
    }
    if (frame.dataStr === "[DONE]") {
      flush();
      emit(`${block}\n\n`);
      return;
    }

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(frame.dataStr) as Record<string, unknown>;
    } catch {
      emit(`${block}\n\n`);
      return;
    }

    const choices = evt.choices;
    if (!Array.isArray(choices)) {
      emit(`${block}\n\n`);
      return;
    }

    let current: HeldChunk | null = null;
    let finished = false;
    for (const choice of choices) {
      const ch = choice as Record<string, unknown> | null;
      if (!ch) continue;
      if (ch.finish_reason !== null && ch.finish_reason !== undefined) finished = true;
      const delta = ch.delta as Record<string, unknown> | undefined;
      const toolCalls = delta?.tool_calls;
      if (!Array.isArray(toolCalls)) continue;
      const choiceIndex = typeof ch.index === "number" ? ch.index : 0;
      for (const tc of toolCalls) {
        const t = tc as Record<string, unknown> | null;
        const fn = t?.function as Record<string, unknown> | undefined;
        if (!t) continue;
        // 依赖上游给 index（chat 流式规范里是必填）。真缺了的话并行 tool_call 会
        // 塌到同一个 key，参数被拼在一起——目前所有上游都带，暂不额外兜底。
        const tcIndex = typeof t.index === "number" ? t.index : 0;
        const key = `${choiceIndex}:${tcIndex}`;
        const toolName = typeof fn?.name === "string" ? fn.name : undefined;
        if (toolName && shouldStrip(toolName)) {
          eligible.add(key);
          toolNameOf.set(key, toolName);
        }
        if (typeof t.id === "string") toolIdOf.set(key, t.id);
        if (!eligible.has(key) || typeof fn?.arguments !== "string" || fn.arguments === "") {
          continue;
        }
        buf.set(key, (buf.get(key) ?? "") + fn.arguments);

        // 让位：同一个 tool_call 又来了新分片，早到的那片一律换成空串。
        // 两片落在同一帧里时只能换载荷，不能把这帧提前发走——它还在手上，
        // 提前发等于把没清理的原文漏出去，之后结算又会把整帧再发一次。
        const previous = heldByKey.get(key);
        if (previous) {
          const slot = previous.slots.get(key);
          if (slot) slot.arguments = "";
          if (previous !== current) {
            previous.slots.delete(key);
            heldByKey.delete(key);
            if (previous.slots.size === 0) emitHeld(previous);
          }
        }

        current ??= { frame, evt, slots: new Map() };
        current.slots.set(key, fn);
        heldByKey.set(key, current);
      }
    }

    if (current) {
      if (finished) {
        // 收尾帧自己就带着最后一批分片：先结清更早扣住的帧，再原样发出自己。
        flush();
        for (const [key, fn] of current.slots) settle(key, fn);
        for (const key of current.slots.keys()) heldByKey.delete(key);
        emit(rebuildFrame(frame, evt));
        return;
      }
      heldOrder.push(current);
      return;
    }

    // 结算必须排在 finish chunk 之前，否则客户端已经收尾了。
    if (finished) flush();
    emit(`${block}\n\n`);
  };

  return { onBlock, flush };
}

/**
 * 客户端方向的 CFQ 剥离流。挂在响应的最后一公里，tap 那一路不受影响。
 */
export function createCfqStripStream(
  protocol: CfqStripProtocol,
  selection: CfqStripSelection,
  observer?: CfqStripObserver,
): TransformStream<Uint8Array, Uint8Array> {
  // No schema was extended in this request: preserve chunk boundaries and
  // bytes exactly. Besides avoiding needless buffering, this protects tools
  // that legitimately own a field with the same name.
  if (!selectionHasWork(selection)) {
    return new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
    });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let sseBuf = "";
  const tracker = createStripTracker(protocol, true, observer);
  const shouldStrip = trackEligible(selection, tracker.markEligible);

  // `emit` 在每次回调里重新绑定到当前 controller，剥离器本身不持有 controller。
  let emit: Emit = () => {};
  const forward: Emit = (text) => emit(text);
  const stripper =
    protocol === "anthropic"
      ? makeAnthropicStripper(forward, shouldStrip, tracker.mark)
      : protocol === "responses"
        ? makeResponsesStripper(forward, shouldStrip, tracker.mark)
        : makeChatStripper(forward, shouldStrip, tracker.mark);

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      emit = (text) => controller.enqueue(encoder.encode(text));
      sseBuf += decoder.decode(chunk, { stream: true });

      // SSE accepts LF and CRLF line endings. Normalise rewritten frames to LF;
      // inactive requests took the byte-for-byte passthrough branch above.
      const parts = sseBuf.split(/\r?\n\r?\n/);
      sseBuf = parts.pop() ?? "";
      for (const part of parts) {
        if (part !== "") stripper.onBlock(part);
      }
    },
    flush(controller) {
      emit = (text) => controller.enqueue(encoder.encode(text));
      // 先结清扣住的帧，再把残留的半截帧原样吐出去——残留的必然是个不完整事件，
      // 交给剥离器只会给它补上一个不该有的事件结束符。
      stripper.flush();
      if (sseBuf) controller.enqueue(encoder.encode(sseBuf));
      tracker.report();
    },
  });
}
