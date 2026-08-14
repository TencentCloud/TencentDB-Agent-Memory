import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  TdaiMemoryClient,
  turnKey,
  type CaptureTurn,
  type MemoryClientLike,
} from "./client.js";
import { buildCaptureTurns } from "./capture.js";
import { loadConfig, type PiMemoryConfig } from "./config.js";
import { formatRecallContext } from "./format.js";
import { registerInvalidConfigStatusCommand, registerMemoryToolsAndCommands } from "./tools.js";

export interface ExtensionDependencies {
  env?: Record<string, string | undefined>;
  clientFactory?: (config: PiMemoryConfig) => MemoryClientLike;
  logger?: Pick<Console, "warn">;
  now?: () => number;
}

const CAPTURE_ENTRY_TYPE = "tdai-memory-captured";
const CAPTURE_MARKER_VERSION = 5;
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
      registerInvalidConfigStatusCommand(pi, loaded.errors);
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
    let captureSequence = 0;

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

    const persistPending = (
      key: string,
      status: CaptureStatus,
      turn: CaptureTurn,
      retries: number,
    ): void => {
      try {
        pi.appendEntry(CAPTURE_ENTRY_TYPE, {
          version: CAPTURE_MARKER_VERSION,
          key,
          l0: status.l0,
          skill: status.skill,
          retries,
          turn,
        });
      } catch (error) {
        logger.warn("[tdai-memory] could not persist capture marker: " + messageOf(error));
      }
    };

    // Compact status marker (no turn payload): written once per turn on completion or
    // partial progress, so each turn yields at most 2 entries (pending + status).
    const persistStatus = (
      key: string,
      status: CaptureStatus,
      retries: number,
      dead = false,
    ): void => {
      try {
        pi.appendEntry(CAPTURE_ENTRY_TYPE, {
          version: CAPTURE_MARKER_VERSION,
          key,
          l0: status.l0,
          skill: status.skill,
          retries,
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
        const item = pending.get(oldest);
        pending.delete(oldest);
        if (item) persistStatus(oldest, item.status, item.retries, true);
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
          persistStatus(key, status, item.retries);
          recordSuccess();
          setStatus(ctx, "memory: synced");
        } else if (turnFailed) {
          // Count once per turn (not per pipeline) so a dual-pipeline failure does not
          // double-count toward the retry cap or accelerate backoff prematurely.
          item.retries += 1;
          if (item.retries >= MAX_RETRIES) {
            pending.delete(key);
            persistStatus(key, status, item.retries, true);
            logger.warn(
              "[tdai-memory] giving up on turn " + key + " after " + MAX_RETRIES + " retries",
            );
          } else {
            persistStatus(key, status, item.retries);
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
      const statusesByKey = new Map<string, CaptureStatus>();
      const retriesByKey = new Map<string, number>();
      const deadKeys = new Set<string>();
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
              retries?: unknown;
            }
          | undefined;
        if (!data || typeof data.key !== "string") continue;
        if (data.dead === true) {
          deadKeys.add(data.key);
          turnsByKey.delete(data.key);
          statusesByKey.delete(data.key);
          retriesByKey.delete(data.key);
          continue;
        }
        deadKeys.delete(data.key);
        if (data.turn && typeof data.turn === "object") {
          turnsByKey.set(data.key, data.turn as CaptureTurn);
        }
        const isCurrent =
          data.version === CAPTURE_MARKER_VERSION ||
          data.version === 4 ||
          data.version === 3 ||
          data.version === 2;
        const prior = statusesByKey.get(data.key);
        const next = isCurrent
          ? { l0: prior?.l0 === true || data.l0 === true, skill: prior?.skill === true || data.skill === true }
          : { l0: true, skill: prior?.skill === true };
        statusesByKey.set(data.key, next);
        const entryRetries =
          data.version === CAPTURE_MARKER_VERSION &&
          typeof data.retries === "number" &&
          Number.isInteger(data.retries) &&
          data.retries >= 0
            ? data.retries
            : 0;
        retriesByKey.set(data.key, Math.max(retriesByKey.get(data.key) ?? 0, entryRetries));
      }
      for (const [key, status] of statusesByKey) {
        if (!deadKeys.has(key)) rememberCaptured(key, status);
      }
      for (const [key, turn] of turnsByKey) {
        if (deadKeys.has(key)) continue;
        const status = captured.get(key);
        if (status && (!status.l0 || !status.skill)) {
          pending.set(key, {
            turn,
            status: { l0: status.l0, skill: status.skill },
            retries: retriesByKey.get(key) ?? 0,
          });
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
      if (activePrompts.length === 0 || !Array.isArray(event.messages)) return;
      settledCandidate.push(...event.messages);
    });

    pi.on("agent_settled", async (_event, ctx) => {
      if (activePrompts.length > 0) {
        const turns = buildCaptureTurns(
          sessionId(ctx),
          activePrompts.join("\n\n--- queued follow-up ---\n\n"),
          settledCandidate,
          config.maxCaptureChars,
          now(),
          config.maxSkillBytes,
          () => sessionId(ctx) + ":" + now() + ":" + captureSequence++,
        );
        for (const turn of turns) {
          const key = turnKey(turn);
          const status = captured.get(key) ?? { l0: false, skill: false };
          if (!status.l0 || !status.skill) {
            if (pending.size >= MAX_PENDING) evictOldestPending();
            pending.set(key, { turn, status: { l0: status.l0, skill: status.skill }, retries: 0 });
            persistPending(key, status, turn, 0);
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
      await flushPending(ctx, true);
      if (pending.size > 0) {
        logger.warn(
          "[tdai-memory] session closing while " +
            pending.size +
            " capture(s) remain pending; persisted entries will retry on next session_start if needed",
        );
      }
    });

    registerMemoryToolsAndCommands(pi, client, config);
  };
}
