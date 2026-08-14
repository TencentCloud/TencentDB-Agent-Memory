import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  TdaiMemoryClient,
  turnKey,
  type CaptureTurn,
  type MemoryClientLike,
} from "./client.js";
import { buildCaptureTurn, hasCompletedAssistant } from "./capture.js";
import { loadConfig, type PiMemoryConfig } from "./config.js";
import {
  formatAtomicResults,
  formatConversationResults,
  formatRecallContext,
} from "./format.js";

export interface ExtensionDependencies {
  env?: Record<string, string | undefined>;
  clientFactory?: (config: PiMemoryConfig) => MemoryClientLike;
  logger?: Pick<Console, "warn">;
  now?: () => number;
}

const CAPTURE_ENTRY_TYPE = "tdai-memory-captured";
const CAPTURE_MARKER_VERSION = 4;
const MAX_PENDING = 64;
const MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 30_000;

interface CaptureStatus {
  l0: boolean;
  skill: boolean;
}

interface PendingCapture {
  turn: CaptureTurn;
  status: CaptureStatus;
  retries: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionId(ctx: ExtensionContext): string {
  return "pi:" + ctx.sessionManager.getSessionId();
}

function finalAssistantEntryId(ctx: ExtensionContext): string | undefined {
  const manager = ctx.sessionManager as ExtensionContext["sessionManager"] & {
    getBranch?: () => Array<{ id?: unknown; type?: unknown; message?: unknown }>;
  };
  const entries = manager.getBranch?.() ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.type !== "message" || typeof entry.id !== "string") continue;
    const message = entry.message as { role?: unknown; stopReason?: unknown } | undefined;
    if (
      message?.role === "assistant" &&
      !["error", "aborted"].includes(String(message.stopReason))
    ) {
      return entry.id;
    }
  }
  return undefined;
}

function setStatus(ctx: ExtensionContext, value: string): void {
  if (ctx.hasUI) ctx.ui.setStatus("tdai-memory", value);
}

function notify(ctx: ExtensionContext, value: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(value, level);
}

export function createTencentDbMemoryExtension(dependencies: ExtensionDependencies = {}) {
  const env = dependencies.env ?? process.env;
  const logger = dependencies.logger ?? console;
  const now = dependencies.now ?? (() => Date.now());
  const clientFactory =
    dependencies.clientFactory ?? ((config: PiMemoryConfig) => new TdaiMemoryClient(config));

  return function tencentDbMemory(pi: ExtensionAPI): void {
    const loaded = loadConfig(env);
    if (!loaded.ok) {
      pi.registerCommand("tdai-memory-status", {
        description: "Show TencentDB Agent Memory adapter status",
        handler: async (_args, ctx) => {
          notify(ctx, "TencentDB memory is disabled: " + loaded.errors.join("; "), "warning");
        },
      });
      return;
    }

    const config = loaded.value;
    const client = clientFactory(config);
    const pending = new Map<string, PendingCapture>();
    const captured = new Map<string, CaptureStatus>();
    const capturedOrder: string[] = [];
    const activePrompts: string[] = [];
    let settledCandidate: unknown[] = [];
    let flushing: Promise<void> | undefined;
    let consecutiveFailures = 0;
    let backoffUntil = 0;

    const rememberCaptured = (key: string, status: Partial<CaptureStatus>): CaptureStatus => {
      const merged = {
        l0: captured.get(key)?.l0 === true || status.l0 === true,
        skill: captured.get(key)?.skill === true || status.skill === true,
      };
      captured.set(key, merged);
      if (!capturedOrder.includes(key)) capturedOrder.push(key);
      if (capturedOrder.length > 512) {
        const oldest = capturedOrder.shift();
        if (oldest) captured.delete(oldest);
      }
      return merged;
    };

    const persistPending = (key: string, status: CaptureStatus, turn: CaptureTurn): void => {
      try {
        pi.appendEntry(CAPTURE_ENTRY_TYPE, {
          version: CAPTURE_MARKER_VERSION,
          key,
          l0: status.l0,
          skill: status.skill,
          turn,
        });
      } catch (error) {
        logger.warn("[tdai-memory] could not persist capture marker: " + messageOf(error));
      }
    };

    // Compact status marker (no turn payload): written once per turn on completion or
    // partial progress, so each turn yields at most 2 entries (pending + status).
    const persistStatus = (key: string, status: CaptureStatus, dead = false): void => {
      try {
        pi.appendEntry(CAPTURE_ENTRY_TYPE, {
          version: CAPTURE_MARKER_VERSION,
          key,
          l0: status.l0,
          skill: status.skill,
          dead,
        });
      } catch (error) {
        logger.warn("[tdai-memory] could not persist capture marker: " + messageOf(error));
      }
    };

    const recordFailure = (): void => {
      consecutiveFailures += 1;
      const backoff = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(consecutiveFailures, 5));
      backoffUntil = now() + backoff;
    };

    const recordSuccess = (): void => {
      consecutiveFailures = 0;
      backoffUntil = 0;
    };

    const evictOldestPending = (): void => {
      const oldest = pending.keys().next().value;
      if (oldest) {
        pending.delete(oldest);
        logger.warn("[tdai-memory] pending queue full; dropped oldest capture " + oldest);
      }
    };

    const doFlush = async (ctx: ExtensionContext, force: boolean): Promise<void> => {
      if (!force && now() < backoffUntil) return;
      for (const [key, item] of pending) {
        const status = rememberCaptured(key, item.status);
        let turnFailed = false;
        if (!status.l0) {
          try {
            await client.captureTurn(item.turn, ctx.signal);
            status.l0 = true;
            rememberCaptured(key, status);
          } catch (error) {
            turnFailed = true;
            logger.warn("[tdai-memory] L0 capture failed: " + messageOf(error));
          }
        }
        if (!status.skill) {
          try {
            await client.captureSkill(item.turn, ctx.signal);
            status.skill = true;
            rememberCaptured(key, status);
          } catch (error) {
            turnFailed = true;
            logger.warn("[tdai-memory] Skill capture failed: " + messageOf(error));
          }
        }

        item.status = status;
        if (status.l0 && status.skill) {
          pending.delete(key);
          persistStatus(key, status);
          recordSuccess();
          setStatus(ctx, "memory: synced");
        } else if (turnFailed) {
          // Count once per turn (not per pipeline) so a dual-pipeline failure does not
          // double-count toward the retry cap or accelerate backoff prematurely.
          item.retries += 1;
          if (item.retries >= MAX_RETRIES) {
            pending.delete(key);
            persistStatus(key, status, true);
            logger.warn(
              "[tdai-memory] giving up on turn " + key + " after " + MAX_RETRIES + " retries",
            );
          } else {
            persistStatus(key, status);
            // A partial success means the service is reachable: reset backoff so the
            // healthy pipeline is not stalled. A full failure escalates backoff.
            if (status.l0 || status.skill) recordSuccess();
            else recordFailure();
          }
        }
      }
    };

    const flushPending = (ctx: ExtensionContext, force = false): Promise<void> => {
      if (flushing) return flushing;
      flushing = doFlush(ctx, force).finally(() => {
        flushing = undefined;
      });
      return flushing;
    };

    pi.on("session_start", async (_event, ctx) => {
      pending.clear();
      captured.clear();
      capturedOrder.length = 0;
      activePrompts.length = 0;
      settledCandidate = [];
      const manager = ctx.sessionManager as ExtensionContext["sessionManager"] & {
        getBranch?: () => ReturnType<ExtensionContext["sessionManager"]["getEntries"]>;
      };
      const turnsByKey = new Map<string, CaptureTurn>();
      for (const entry of manager.getBranch?.() ?? ctx.sessionManager.getEntries()) {
        if (entry.type !== "custom" || entry.customType !== CAPTURE_ENTRY_TYPE) continue;
        const data = entry.data as
          | {
              key?: unknown;
              version?: unknown;
              l0?: unknown;
              skill?: unknown;
              turn?: unknown;
              dead?: unknown;
            }
          | undefined;
        if (!data || typeof data.key !== "string") continue;
        if (data.dead === true) continue;
        if (data.turn && typeof data.turn === "object") {
          turnsByKey.set(data.key, data.turn as CaptureTurn);
        }
        const isCurrent =
          data.version === CAPTURE_MARKER_VERSION || data.version === 3 || data.version === 2;
        rememberCaptured(
          data.key,
          isCurrent
            ? { l0: data.l0 === true, skill: data.skill === true }
            : { l0: true, skill: false },
        );
      }
      for (const [key, turn] of turnsByKey) {
        const status = captured.get(key);
        if (status && (!status.l0 || !status.skill)) {
          pending.set(key, { turn, status: { l0: status.l0, skill: status.skill }, retries: 0 });
        }
      }
      setStatus(ctx, "memory: on");
      // Fire-and-forget: compensating previously-failed pipelines must not block Pi startup.
      void flushPending(ctx, false);
    });

    pi.on("before_agent_start", async (event, ctx) => {
      const prompt = event.prompt.trim();
      if (prompt) activePrompts.push(event.prompt);
      if (!prompt) return;
      try {
        const recalled = await client.recall(event.prompt, ctx.signal);
        const context = formatRecallContext(recalled, config.maxContextChars);
        setStatus(ctx, recalled.warnings.length > 0 ? "memory: partial" : "memory: recalled");
        if (!context) return;
        return { systemPrompt: event.systemPrompt + "\n\n" + context };
      } catch (error) {
        setStatus(ctx, "memory: offline");
        logger.warn("[tdai-memory] recall failed: " + messageOf(error));
        return;
      }
    });

    pi.on("agent_end", async (event) => {
      if (activePrompts.length === 0 || !hasCompletedAssistant(event.messages)) return;
      settledCandidate.push(...event.messages);
    });

    pi.on("agent_settled", async (_event, ctx) => {
      if (activePrompts.length > 0) {
        const turn = buildCaptureTurn(
          sessionId(ctx),
          activePrompts.join("\n\n--- queued follow-up ---\n\n"),
          settledCandidate,
          config.maxCaptureChars,
          now(),
          config.maxSkillBytes,
          finalAssistantEntryId(ctx),
        );
        if (turn) {
          const key = turnKey(turn);
          const status = captured.get(key) ?? { l0: false, skill: false };
          if (!status.l0 || !status.skill) {
            if (pending.size >= MAX_PENDING) evictOldestPending();
            pending.set(key, { turn, status: { l0: status.l0, skill: status.skill }, retries: 0 });
            persistPending(key, status, turn);
          }
        }
      }
      activePrompts.length = 0;
      settledCandidate = [];
      await flushPending(ctx, false);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      activePrompts.length = 0;
      settledCandidate = [];
      void flushPending(ctx, true);
      if (pending.size > 0) {
        logger.warn(
          "[tdai-memory] session closed with " + pending.size + " unsynced capture(s)",
        );
      }
    });

    pi.registerTool({
      name: "tdai_memory_search",
      label: "Search TencentDB memory",
      description: "Search long-term atomic memories stored in TencentDB Agent Memory.",
      promptSnippet: "Search durable user, project, and decision memories",
      promptGuidelines: [
        "Use tdai_memory_search when earlier preferences, decisions, or project facts may help.",
      ],
      parameters: Type.Object(
        {
          query: Type.String({ minLength: 1, description: "Semantic memory search query" }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, params, signal) {
        try {
          const items = await client.searchAtomic(
            params.query,
            params.limit ?? config.recallLimit,
            signal,
          );
          return {
            content: [{ type: "text", text: formatAtomicResults(items, config.maxContextChars) }],
            details: { count: items.length, items },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: "Memory search failed: " + messageOf(error) }],
            details: { count: 0, items: [] as Awaited<ReturnType<typeof client.searchAtomic>> },
            isError: true,
          };
        }
      },
    });

    pi.registerTool({
      name: "tdai_conversation_search",
      label: "Search TencentDB conversations",
      description: "Search raw prior conversations stored in TencentDB Agent Memory.",
      promptSnippet: "Search prior user and assistant conversation text",
      promptGuidelines: [
        "Use tdai_conversation_search only when raw conversation evidence is needed.",
      ],
      parameters: Type.Object(
        {
          query: Type.String({ minLength: 1, description: "Conversation search query" }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
          sessionOnly: Type.Optional(
            Type.Boolean({ description: "Limit results to the current Pi session" }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        try {
          const items = await client.searchConversation(
            params.query,
            params.limit ?? config.recallLimit,
            params.sessionOnly ? sessionId(ctx) : undefined,
            signal,
          );
          return {
            content: [
              { type: "text", text: formatConversationResults(items, config.maxContextChars) },
            ],
            details: { count: items.length, items },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: "Conversation search failed: " + messageOf(error) }],
            details: {
              count: 0,
              items: [] as Awaited<ReturnType<typeof client.searchConversation>>,
            },
            isError: true,
          };
        }
      },
    });

    pi.registerCommand("tdai-memory-status", {
      description: "Check TencentDB Agent Memory connectivity",
      handler: async (_args, ctx) => {
        try {
          const count = await client.check(ctx.signal);
          setStatus(ctx, "memory: online");
          if (count === null) {
            notify(ctx, "TencentDB memory is online (count unavailable).", "info");
          } else {
            notify(ctx, "TencentDB memory is online (" + count + " atomic memories).", "info");
          }
        } catch (error) {
          setStatus(ctx, "memory: offline");
          notify(ctx, "TencentDB memory check failed: " + messageOf(error), "error");
        }
      },
    });
  };
}
