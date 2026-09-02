/**
 * Session context injector — appends Agent persona + Task description to the
 * system message of every request after session initialisation completes.
 *
 * Why here (vs. the generic `injection` pipeline):
 *   The plan requires "every request must carry the agent/task context", but
 *   the generic pipeline only runs when `config.injection.enabled` and at
 *   least one injector is registered. Agent/Task context is session identity,
 *   not optional enrichment, so it lives in the session module and bypasses
 *   that gating.
 *
 * Behaviour:
 *   - If a `system` role message exists, append the context block to the
 *     **end** of its content (string and Anthropic-style array both
 *     supported).
 *   - Otherwise, prepend a brand-new system message at index 0.
 *   - When both details are absent, returns the input unchanged.
 *
 * The block is bracketed with `<session_context>` markers so downstream
 * tooling can identify it deterministically without parsing prose.
 */

import type { AgentDetail, TaskDetail } from "./types.js";
import type { SessionInitConfig } from "../types.js";

interface RawMessage {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
}

interface TextBlock {
  type?: unknown;
  text?: unknown;
  [key: string]: unknown;
}

const CTX_OPEN = "<session_context>";
const CTX_CLOSE = "</session_context>";

// ── Block builder ──────────────────────────────────────────────────────────────

function buildContextBlock(
  agent: AgentDetail | null | undefined,
  task: TaskDetail | null | undefined,
  includeMissingTaskNotice = true,
): string | null {
  if (!agent && !task) return null;

  const lines: string[] = [CTX_OPEN];

  if (agent) {
    lines.push("[Agent]");
    lines.push(`id: ${agent.id}`);
    if (agent.name) lines.push(`name: ${agent.name}`);
    if (agent.description) lines.push(`description: ${agent.description}`);
    if (agent.prompt) {
      lines.push("prompt:");
      lines.push(agent.prompt);
    }
  }

  if (task) {
    if (lines.length > 1) lines.push("");
    lines.push("[Task]");
    lines.push(`id: ${task.id}`);
    if (task.name) lines.push(`name: ${task.name}`);
    if (task.description) lines.push(`description: ${task.description}`);
    if (task.goal && task.goal !== task.description) {
      lines.push("goal:");
      lines.push(task.goal);
    }
  } else if (agent && includeMissingTaskNotice) {
    lines.push("");
    lines.push("[Task]");
    lines.push("status: not_bound");
    lines.push("hint: 如需任务级记忆请添加 x-task-id");
  }

  lines.push(CTX_CLOSE);
  return lines.join("\n");
}

// ── Mutation helpers ───────────────────────────────────────────────────────────

function appendToSystem(systemMsg: RawMessage, block: string): RawMessage {
  const content = systemMsg.content;

  if (typeof content === "string") {
    return { ...systemMsg, content: content.length > 0 ? `${content}\n\n${block}` : block };
  }

  if (Array.isArray(content)) {
    // Anthropic-style system content blocks. Append a new text block.
    const cloned = [...(content as TextBlock[])];
    cloned.push({ type: "text", text: block });
    return { ...systemMsg, content: cloned };
  }

  // Unknown shape (null/undefined/object) — coerce to string.
  return { ...systemMsg, content: block };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Inject the agent/task context block into the first system message of
 * `messages`. If no system message exists, insert one at the head.
 *
 * Pure function — returns a new array; the original is not mutated.
 */
export function injectSessionContext(
  messages: RawMessage[],
  agent: AgentDetail | null | undefined,
  task: TaskDetail | null | undefined,
): RawMessage[] {
  const block = buildContextBlock(agent ?? null, task ?? null);
  if (!block) return messages;

  const sysIdx = messages.findIndex((m) => m.role === "system");
  if (sysIdx === -1) {
    return [{ role: "system", content: block }, ...messages];
  }

  const next = [...messages];
  next[sysIdx] = appendToSystem(next[sysIdx], block);
  return next;
}

/** Exposed for tests. */
export const SESSION_CONTEXT_OPEN = CTX_OPEN;
export const SESSION_CONTEXT_CLOSE = CTX_CLOSE;

// ── Toggle-aware wrapper ───────────────────────────────────────────────────────

/**
 * Per-session dedup for the "context suppressed" warn logs.
 * Each `(sessionKey, kind)` pair is logged at most once so long-lived
 * sessions don't spam the log every turn. Bounded to avoid unbounded growth
 * if lots of sessions come and go — a hard cap + clear is enough (we only
 * lose the "have I warned before?" bit, worst case = one extra warn line
 * per session per kind after the cap wraps).
 */
const warnedSuppress = new Set<string>();
const WARN_CAP = 10_000;

function warnOnce(sessionKey: string, kind: "agent" | "task"): void {
  const key = `${sessionKey}:${kind}`;
  if (warnedSuppress.has(key)) return;
  if (warnedSuppress.size >= WARN_CAP) warnedSuppress.clear();
  warnedSuppress.add(key);
  const flag = kind === "agent" ? "injectAgentContext" : "injectTaskContext";
  const section = kind === "agent" ? "[Agent]" : "[Task]";
  // eslint-disable-next-line no-console
  console.log(
    `[session-init] session=${sessionKey} ${flag}=false — ${section} section suppressed`,
  );
}

/**
 * Apply the `sessionInit.injectAgentContext` / `injectTaskContext` toggles,
 * then call {@link injectSessionContext}. A single call site both consults
 * config and emits the per-session warn log, so every invocation
 * (session-init completion, OpenAI recovery, Anthropic recovery) behaves
 * identically.
 *
 * A `null` config is treated as "both toggles on" — this matches the
 * historical default and keeps unit tests that don't build a config trivial.
 */
export function injectSessionContextWithToggles(
  messages: RawMessage[],
  agent: AgentDetail | null | undefined,
  task: TaskDetail | null | undefined,
  config: Pick<SessionInitConfig, "injectAgentContext" | "injectTaskContext"> | null | undefined,
  sessionKey: string,
): RawMessage[] {
  const injectAgent = config?.injectAgentContext !== false;
  const injectTask = config?.injectTaskContext !== false;

  if (!injectAgent && agent) warnOnce(sessionKey, "agent");
  if (!injectTask && task) warnOnce(sessionKey, "task");

  const agentForCtx = injectAgent ? (agent ?? null) : null;
  const taskForCtx = injectTask ? (task ?? null) : null;
  const block = buildContextBlock(agentForCtx, taskForCtx, injectTask);
  if (!block) return messages;

  const sysIdx = messages.findIndex((m) => m.role === "system");
  if (sysIdx === -1) return [{ role: "system", content: block }, ...messages];
  const next = [...messages];
  next[sysIdx] = appendToSystem(next[sysIdx], block);
  return next;
}

/** Reset the warn-once dedup set. Test-only. */
export function __resetSessionContextWarnState(): void {
  warnedSuppress.clear();
}

/**
 * Build the `<session_context>` string (or null) with toggle + per-session
 * warn semantics identical to {@link injectSessionContextWithToggles}, but
 * without touching any message container. Used by the Anthropic session-init
 * path: the init module knows the details but does NOT have access to
 * `body.system`; it hands the pre-built block back through
 * `SessionInitResult.systemAppend` and the HTTP handler applies it to
 * `body.system` at the boundary.
 *
 * Returns `null` when nothing would be injected (both toggles off, or both
 * agent+task empty). Callers should treat `null` as "leave system alone".
 */
export function buildSessionContextBlockWithToggles(
  agent: AgentDetail | null | undefined,
  task: TaskDetail | null | undefined,
  config: Pick<SessionInitConfig, "injectAgentContext" | "injectTaskContext"> | null | undefined,
  sessionKey: string,
): string | null {
  const injectAgent = config?.injectAgentContext !== false;
  const injectTask = config?.injectTaskContext !== false;

  if (!injectAgent && agent) warnOnce(sessionKey, "agent");
  if (!injectTask && task) warnOnce(sessionKey, "task");

  const agentForCtx = injectAgent ? (agent ?? null) : null;
  const taskForCtx = injectTask ? (task ?? null) : null;
  return buildContextBlock(agentForCtx, taskForCtx, injectTask);
}

// ── Anthropic system-field variant ────────────────────────────────────────────

/**
 * Append the `<session_context>` block onto Anthropic's top-level
 * `body.system` field.
 *
 * Why a separate function instead of reusing {@link injectSessionContext}:
 * Anthropic keeps the system prompt at `body.system` (string OR ContentBlock[]),
 * NOT inside `body.messages`. The pipeline adapter parses only `body.system`
 * and serializes only `body.system` — anything we prepend to `body.messages` as
 * `{role:"system",...}` gets silently filtered out by the adapter's system
 * dedup (`find` returns the parsed original, `filter` drops the rest). So on
 * Anthropic the historical `injectSessionContext` was a no-op sink.
 *
 * This helper reads `body.system` directly and returns the new value the
 * caller should write back. Behaviour mirrors {@link injectSessionContextWithToggles}
 * exactly for the toggle / warn semantics — the two entry points are meant to
 * be interchangeable per protocol.
 *
 * Cache-control preservation: when `system` is an array whose last block
 * carries `cache_control` (Claude Code's typical prompt-caching shape), we
 * keep that marker where it is and append a *plain* text block after it. The
 * agent/task info is per-session-stable, so leaving the breakpoint in place
 * means the cached prefix still covers the client's original content — only
 * the appended block sits outside the cache. Adding a second `cache_control`
 * on the new block would create an unrequested breakpoint (Anthropic charges
 * for those), so we deliberately do not.
 *
 * Pure function — never mutates the input array.
 */
export function injectSessionContextIntoAnthropicSystem(
  system: unknown,
  agent: AgentDetail | null | undefined,
  task: TaskDetail | null | undefined,
  config: Pick<SessionInitConfig, "injectAgentContext" | "injectTaskContext"> | null | undefined,
  sessionKey: string,
): unknown {
  const injectAgent = config?.injectAgentContext !== false;
  const injectTask = config?.injectTaskContext !== false;

  if (!injectAgent && agent) warnOnce(sessionKey, "agent");
  if (!injectTask && task) warnOnce(sessionKey, "task");

  const agentForCtx = injectAgent ? (agent ?? null) : null;
  const taskForCtx = injectTask ? (task ?? null) : null;
  const block = buildContextBlock(agentForCtx, taskForCtx, injectTask);
  if (!block) return system;
  return appendBlockToAnthropicSystem(system, block);
}

/**
 * Low-level append: given an existing Anthropic `body.system` (string, array,
 * or missing) and an already-built block string, return the new system value.
 * Preserves array shape + cache_control on the pre-existing last block; the
 * appended text block never carries cache_control (see
 * {@link injectSessionContextIntoAnthropicSystem} for rationale).
 *
 * Exported so callers that have already produced the block via
 * {@link buildSessionContextBlockWithToggles} (e.g. the HTTP handler joining
 * `SessionInitResult.systemAppend` with `body.system`) can reuse the same
 * append arithmetic without going through the toggle path a second time.
 */
export function appendBlockToAnthropicSystem(system: unknown, block: string): unknown {
  if (typeof system === "string") {
    return system.length > 0 ? `${system}\n\n${block}` : block;
  }
  if (Array.isArray(system)) {
    return [...(system as unknown[]), { type: "text", text: block }];
  }
  // system is null / undefined / unrecognized shape → emit as a string.
  return block;
}
