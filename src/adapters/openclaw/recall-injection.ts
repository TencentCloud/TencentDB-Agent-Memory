import { createHash } from "node:crypto";
import type { RecallResult } from "../../core/types.js";
import { fastEstimateTokens } from "../../offload/fast-token-estimate.js";

export type RecallInjectionMode = "prepend" | "append" | "epoch";

export interface OpenClawRecallHookResult {
  prependSystemContext?: string;
  prependContext?: string;
  appendContext?: string;
}

interface EpochMemory {
  id: string;
  text: string;
}

interface SessionEpochState {
  stableSystemContext?: string;
  stableSnapshotHash?: string;
  stableCacheEpoch?: number;
  epoch: number;
  registered: Map<string, EpochMemory>;
  focused: Set<string>;
  checkpointRequired: boolean;
  sealed: boolean;
  tokenCount: number;
}

interface PendingEpoch {
  turnId: string;
  result: EpochRecallHookResult;
}

export interface EpochRecallHookResult extends OpenClawRecallHookResult {
  stableCacheEpoch?: number;
  memoryEpoch: number;
  memoryEpochChanged: boolean;
  memoryEpochSealed: boolean;
  memoryEpochTokens: number;
  memoryEpochTokenBudget: number;
  stableSnapshotHash?: string;
}

const DEFAULT_EPOCH_MAX_TOKENS = 8192;
const EPOCH_CONTEXT_SHARE = 0.1;
const RELEVANT_MEMORIES_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g;
const MEMORY_EPOCH_RE = /<!-- tdai-memory-epoch:(\d+) (delta|checkpoint)\n([\s\S]*?)\n-->/g;
const REGISTRATION_RE = /^- \[([a-f0-9]{12})\] (.+)$/gm;
const FOCUS_RE = /^focus: (.+)$/m;
const SEALED_RE = /^sealed: token-budget$/m;

/** Translate host-neutral recall sections into OpenClaw prompt-hook fields. */
export function buildOpenClawRecallHookResult(
  recall: Pick<RecallResult, "appendSystemContext" | "prependContext">,
  injectionMode: RecallInjectionMode,
): OpenClawRecallHookResult {
  const hookResult: OpenClawRecallHookResult = {};

  if (recall.appendSystemContext) {
    hookResult.prependSystemContext = recall.appendSystemContext;
  }

  if (recall.prependContext) {
    if (injectionMode === "append") {
      hookResult.appendContext = recall.prependContext;
    } else {
      hookResult.prependContext = recall.prependContext;
    }
  }

  return hookResult;
}

/**
 * Keeps provider-visible memory bytes append-only across an OpenClaw session.
 *
 * Stable system context is frozen on the first turn. Dynamic recall is emitted
 * as a small epoch event only when the active memory set changes, then the same
 * bytes are persisted with the user turn so the next request can reuse them as
 * history. The HTML comment is model-visible but not rendered by Markdown UIs.
 */
export class OpenClawMemoryEpochLedger {
  private readonly sessions = new Map<string, SessionEpochState>();
  private readonly pending = new Map<string, PendingEpoch[]>();
  private readonly checkpointSessions = new Set<string>();

  constructor(private readonly maxTokens = DEFAULT_EPOCH_MAX_TOKENS) {}

  prepare(params: {
    sessionKey: string;
    sessionId: string;
    turnId: string;
    recall: RecallResult;
    historyMessages?: unknown[];
    contextTokenBudget?: number;
  }): EpochRecallHookResult {
    const prepared = this.pending.get(params.sessionKey)
      ?.find((pending) => pending.turnId === params.turnId);
    if (prepared) return prepared.result;

    const key = this.key(params.sessionKey, params.sessionId);
    let state = this.sessions.get(key);
    if (!state) {
      const previousGeneration = this.removeGenerations(params.sessionKey, key);
      const restored = restoreEpochState(params.historyMessages ?? []);
      state = {
        stableSystemContext: previousGeneration?.stableSystemContext ?? params.recall.appendSystemContext,
        stableSnapshotHash: previousGeneration?.stableSnapshotHash ?? params.recall.stableSnapshotHash,
        stableCacheEpoch: previousGeneration?.stableCacheEpoch ?? params.recall.cacheEpoch,
        epoch: Math.max(previousGeneration?.epoch ?? 0, restored.epoch),
        registered: restored.registered,
        focused: restored.focused,
        checkpointRequired: false,
        sealed: restored.sealed,
        tokenCount: restored.tokenCount,
      };
      this.sessions.set(key, state);
    }
    const session = state;
    if (params.recall.cacheEpoch !== undefined && params.recall.cacheEpoch !== session.stableCacheEpoch) {
      session.stableSystemContext = params.recall.appendSystemContext;
      session.stableSnapshotHash = params.recall.stableSnapshotHash;
      session.stableCacheEpoch = params.recall.cacheEpoch;
    }
    if (this.checkpointSessions.delete(params.sessionKey)) session.checkpointRequired = true;
    const tokenBudget = params.contextTokenBudget
      ? Math.min(this.maxTokens, Math.max(1, Math.floor(params.contextTokenBudget * EPOCH_CONTEXT_SHARE)))
      : this.maxTokens;

    let epochText: string | undefined;
    let ephemeralText: string | undefined;
    const recalled = toEpochMemories(params.recall);
    if (params.recall.recallStrategy !== "timed-out") {
      const nextFocus = new Set(recalled.map((memory) => memory.id));
      const registrations = recalled.filter((memory) => !session.registered.has(memory.id));
      const focusChanged = !sameIds(session.focused, nextFocus);

      if (session.checkpointRequired) {
        const checkpoint = formatMemoryEpoch({
          epoch: session.epoch + 1,
          registrations: recalled,
          focus: nextFocus,
          checkpoint: true,
          sealed: false,
        });
        const sealReserve = countEpochTokens(formatMemoryEpoch({
          epoch: session.epoch + 2,
          registrations: [],
          focus: new Set(),
          checkpoint: false,
          sealed: true,
        }));

        session.epoch += 1;
        if (countEpochTokens(checkpoint) + sealReserve <= tokenBudget) {
          epochText = checkpoint;
          session.registered = new Map(recalled.map((memory) => [memory.id, memory]));
          session.focused = nextFocus;
          session.sealed = false;
        } else {
          epochText = formatMemoryEpoch({
            epoch: session.epoch,
            registrations: [],
            focus: new Set(),
            checkpoint: true,
            sealed: true,
          });
          session.registered.clear();
          session.focused.clear();
          session.sealed = true;
          ephemeralText = formatEphemeralRecall(params.recall, recalled);
        }
        session.tokenCount = countEpochTokens(epochText);
        session.checkpointRequired = false;
      } else if (session.sealed) {
        ephemeralText = formatEphemeralRecall(params.recall, recalled);
      } else if (registrations.length > 0 || focusChanged) {
        const candidate = formatMemoryEpoch({
          epoch: session.epoch + 1,
          registrations,
          focus: nextFocus,
          checkpoint: false,
          sealed: false,
        });
        const sealReserve = countEpochTokens(formatMemoryEpoch({
          epoch: session.epoch + 2,
          registrations: [],
          focus: new Set(),
          checkpoint: false,
          sealed: true,
        }));

        session.epoch += 1;
        if (session.tokenCount + countEpochTokens(candidate) + sealReserve <= tokenBudget) {
          epochText = candidate;
          for (const memory of registrations) session.registered.set(memory.id, memory);
          session.focused = nextFocus;
        } else {
          epochText = formatMemoryEpoch({
            epoch: session.epoch,
            registrations: [],
            focus: new Set(),
            checkpoint: false,
            sealed: true,
          });
          session.focused.clear();
          session.sealed = true;
          ephemeralText = formatEphemeralRecall(params.recall, recalled);
        }
        session.tokenCount += countEpochTokens(epochText);
      }
    }

    const result = {
      prependSystemContext: session.stableSystemContext,
      prependContext: epochText,
      appendContext: ephemeralText,
      memoryEpoch: session.epoch,
      memoryEpochChanged: epochText !== undefined,
      memoryEpochSealed: session.sealed,
      memoryEpochTokens: session.tokenCount,
      memoryEpochTokenBudget: tokenBudget,
      stableCacheEpoch: session.stableCacheEpoch,
      stableSnapshotHash: session.stableSnapshotHash,
    };
    const queue = this.pending.get(params.sessionKey) ?? [];
    queue.push({ turnId: params.turnId, result });
    this.pending.set(params.sessionKey, queue);
    return result;
  }

  persist(sessionKey: string, message: { role?: string; content?: unknown }): typeof message | undefined {
    if (message.role !== "user") return undefined;
    const queue = this.pending.get(sessionKey);
    const pending = queue?.shift();
    if (queue?.length === 0) this.pending.delete(sessionKey);
    const epochText = pending?.result.prependContext;
    if (!epochText) return stripLegacyRecall(message);

    if (typeof message.content === "string") {
      const clean = stripLegacyRecallText(message.content);
      const content = clean.startsWith(epochText) ? clean : `${epochText}\n\n${clean}`;
      return content === message.content ? undefined : { ...message, content };
    }

    if (!Array.isArray(message.content)) return undefined;
    let injected = false;
    const content = (message.content as Array<Record<string, unknown>>).map((part) => {
      if (injected || part.type !== "text" || typeof part.text !== "string") return part;
      injected = true;
      const clean = stripLegacyRecallText(part.text);
      return { ...part, text: clean.startsWith(epochText) ? clean : `${epochText}\n\n${clean}` };
    });
    return injected ? { ...message, content } : undefined;
  }

  requireCheckpoint(sessionKey: string): void {
    this.checkpointSessions.add(sessionKey);
  }

  release(sessionKey: string): void {
    this.removeGenerations(sessionKey);
    this.checkpointSessions.delete(sessionKey);
    this.pending.delete(sessionKey);
  }

  private key(sessionKey: string, sessionId: string): string {
    return `${sessionKey}\0${sessionId}`;
  }

  private removeGenerations(sessionKey: string, keep?: string): SessionEpochState | undefined {
    const prefix = `${sessionKey}\0`;
    let previous: SessionEpochState | undefined;
    for (const [key, state] of this.sessions) {
      if (key.startsWith(prefix) && key !== keep) {
        previous ??= state;
        this.sessions.delete(key);
      }
    }
    return previous;
  }
}

function restoreEpochState(
  messages: unknown[],
): Pick<SessionEpochState, "epoch" | "registered" | "focused" | "sealed" | "tokenCount"> {
  const registered = new Map<string, EpochMemory>();
  let focused = new Set<string>();
  let epoch = 0;
  let sealed = false;
  let tokenCount = 0;

  for (const message of messages) {
    const text = userMessageText(message);
    if (!text) continue;
    for (const match of text.matchAll(MEMORY_EPOCH_RE)) {
      epoch = Math.max(epoch, Number(match[1]));
      if (match[2] === "checkpoint") {
        registered.clear();
        tokenCount = 0;
      }
      tokenCount += countEpochTokens(match[0]);

      const body = match[3];
      for (const registration of body.matchAll(REGISTRATION_RE)) {
        registered.set(registration[1], { id: registration[1], text: registration[2] });
      }
      const focus = body.match(FOCUS_RE)?.[1];
      focused = new Set(focus && focus !== "none" ? focus.split(",").map((value) => value.trim()) : []);
      sealed = SEALED_RE.test(body);
    }
  }

  return { epoch, registered, focused, sealed, tokenCount };
}

function sameIds(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

function userMessageText(message: unknown): string | undefined {
  const candidate = message as {
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  };
  if (candidate.role !== "user") return undefined;
  if (typeof candidate.content === "string") return candidate.content;
  return candidate.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function toEpochMemories(
  recall: RecallResult,
): EpochMemory[] {
  const recalled = recall.recalledL1Memories
    ?.map((memory) => `- [${memory.type}] ${memory.content}`) ?? [];
  const unique = new Map<string, EpochMemory>();
  for (const line of recalled) {
    const text = line.trim();
    if (!text) continue;
    const id = createHash("sha256").update(text).digest("hex").slice(0, 12);
    unique.set(id, { id, text });
  }
  return [...unique.values()];
}

function formatMemoryEpoch(params: {
  epoch: number;
  registrations: EpochMemory[];
  focus: Set<string>;
  checkpoint: boolean;
  sealed: boolean;
}): string {
  const lines = [
    `<!-- tdai-memory-epoch:${params.epoch} ${params.checkpoint ? "checkpoint" : "delta"}`,
    "Apply this event cumulatively to the recalled-memory registry and current focus.",
  ];
  if (params.registrations.length) {
    lines.push("register:");
    for (const memory of params.registrations) {
      const text = escapeComment(memory.text.replace(/^-\s*/, ""));
      lines.push(`- [${memory.id}] ${text.includes("\n") ? JSON.stringify(text) : text}`);
    }
  }
  lines.push(`focus: ${params.focus.size ? [...params.focus].join(", ") : "none"}`);
  if (params.sealed) lines.push("sealed: token-budget");
  lines.push("-->");
  return lines.join("\n");
}

function formatEphemeralRecall(recall: RecallResult, recalled: EpochMemory[]): string | undefined {
  if (recall.prependContext) return recall.prependContext;
  if (!recalled.length) return undefined;
  return `<relevant-memories>\n${recalled.map((memory) => memory.text).join("\n\n")}\n</relevant-memories>`;
}

function countEpochTokens(text: string): number {
  return Math.ceil(fastEstimateTokens(text) * 1.1);
}

function escapeComment(value: string): string {
  return value.replaceAll("--", "—");
}

function stripLegacyRecallText(text: string): string {
  return text.includes("<relevant-memories>")
    ? text.replace(RELEVANT_MEMORIES_RE, "").trim()
    : text;
}

function stripLegacyRecall<T extends { role?: string; content?: unknown }>(message: T): T | undefined {
  if (typeof message.content === "string") {
    const content = stripLegacyRecallText(message.content);
    return content === message.content ? undefined : { ...message, content };
  }
  if (!Array.isArray(message.content)) return undefined;
  let changed = false;
  const content = (message.content as Array<Record<string, unknown>>).map((part) => {
    if (part.type !== "text" || typeof part.text !== "string") return part;
    const text = stripLegacyRecallText(part.text);
    changed ||= text !== part.text;
    return text === part.text ? part : { ...part, text };
  });
  return changed ? { ...message, content } : undefined;
}
