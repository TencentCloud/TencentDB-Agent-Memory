 * Plugin state & L3 token consumption reporter.
 *
 * Uploads runtime diagnostics to the backend `/offload/v1/store` endpoint
 * so operators can inspect plugin activity and L3 compression efficiency
 * off-host.
 *
 * The backend keys stored documents by `X-User-Id` (upsert semantics), so
 * every report represents the latest snapshot for that user. We therefore
 * include BOTH:
 *   - `cumulative`: monotonically-increasing counters (total tokens saved,
 *     total tool calls, total L3 triggers) maintained as module-level
 *     globals so they survive across per-trigger reports.
 *   - `recent`: the most recent L3 trigger's detailed accounting
 *     (tokens/msgs before and after) for spot inspection.
 *
 * Four pieces of information are reported on every L3 trigger:
 *   1. Plugin state snapshot (active MMD, pending pairs, L1.5 settled, etc.)
 *   2. L3 token accounting (tokensBefore/After, savings, fixed overhead)
 *   3. Cumulative + recent counters
 *   4. Patch-health signal — only meaningful for `after_tool_call` hook:
 *      the upstream runtime patch is expected to populate `event.messages`
 *      with the current conversation. If `event.messages` is missing/empty
 *      the patch did NOT take effect and L3 cannot operate from this hook.
 *
 * All reporting is fire-and-forget — rejection is logged but never thrown
 * back to the caller so hook execution stays unaffected.
 */
import type { BackendClient, StoreStatePayload } from "./backend-client.js";
import type { OffloadStateManager } from "./state-manager.js";
import type { PluginLogger } from "./types.js";
import { nowChinaISO } from "./time-utils.js";

export type L3TriggerStage = "after_tool_call" | "llm_input" | "assemble";

 * Patch-effectiveness signal derived from the after_tool_call event.
 *
 */
export type PatchEffective = "effective" | "missing_field" | "empty_messages" | "n/a";

  const msgs = (event as { messages?: unknown }).messages;
  if (!Array.isArray(msgs)) return { status: "missing_field", messagesLen: 0 };
  if (msgs.length === 0) return { status: "empty_messages", messagesLen: 0 };
  return { status: "effective", messagesLen: msgs.length };
}

// ─── Global cumulative counters ──────────────────────────────────────────────
//
// Module-level globals that accumulate over the lifetime of the host
// process. They survive across OpenClaw's repeated `registerOffload()` calls
// (which rebuild hook closures but do not reload the module).

interface CumulativeCounters {
  totalTokensSaved: number;
  totalNetTokensSaved: number;
  totalToolCalls: number;
  totalL3Triggers: number;
  totalL3TriggersByStage: Record<L3TriggerStage, number>;
  totalAggressiveDeleted: number;
  totalMildReplaced: number;
  totalEmergencyTriggered: number;
  totalEmergencyDeleted: number;
  startedAt: string;
}

const _counters: CumulativeCounters = {
  totalTokensSaved: 0,
  totalNetTokensSaved: 0,
  totalToolCalls: 0,
  totalL3Triggers: 0,
  totalL3TriggersByStage: { after_tool_call: 0, llm_input: 0, assemble: 0 },
  totalAggressiveDeleted: 0,
  totalMildReplaced: 0,
  totalEmergencyTriggered: 0,
  totalEmergencyDeleted: 0,
  startedAt: nowChinaISO(),
};

 * Record a tool-call observation. Called from the `after_tool_call` hook
 * entry regardless of whether L3 compression fires — it counts *all* tool
 * invocations the plugin has seen.
 */
export function recordToolCall(): void {
  _counters.totalToolCalls += 1;
}

export function getCumulativeCounters(): CumulativeCounters {
  return {
    ..._counters,
    totalL3TriggersByStage: { ..._counters.totalL3TriggersByStage },
  };
}

export function _resetCumulativeCountersForTests(): void {
  _counters.totalTokensSaved = 0;
  _counters.totalNetTokensSaved = 0;
  _counters.totalToolCalls = 0;
  _counters.totalL3Triggers = 0;
  _counters.totalL3TriggersByStage = { after_tool_call: 0, llm_input: 0, assemble: 0 };
  _counters.totalAggressiveDeleted = 0;
  _counters.totalMildReplaced = 0;
  _counters.totalEmergencyTriggered = 0;
  _counters.totalEmergencyDeleted = 0;
  _counters.startedAt = nowChinaISO();
}

// ─── Report payload types ────────────────────────────────────────────────────

export const REPORT_TYPE_L3 = "offload.l3.trigger" as const;

export interface L3TriggerReport {
  reportType: typeof REPORT_TYPE_L3;
  reportedAt: string;
  sessionKey: string | null;
  stage: L3TriggerStage;
  triggerReason: string;
  pluginState: {
    activeMmdFile: string | null;
    l15Settled: boolean;
    pendingCount: number;
    confirmedOffloadCount: number;
    deletedOffloadCount: number;
  };
  recent: {
    tokensBefore: number;
    tokensAfter: number;
    tokensSaved: number;
    netTokensSaved: number;
    messagesBefore: number;
    messagesAfter: number;
    messagesRemoved: number;
    durationMs: number;
  };
  thresholds: {
    contextWindow: number;
    mildThreshold: number;
    aggressiveThreshold: number;
    fixedPatchCostTokens: number;
    utilisationBeforePct: number;
    utilisationAfterPct: number;
  };
  compression: {
    aboveMild: boolean;
    aboveAggressive: boolean;
    mildReplacedCount: number;
    aggressiveDeletedCount: number;
    emergencyTriggered: boolean;
    emergencyDeletedCount: number;
  };
  cumulative: CumulativeCounters;
  patch: {
    status: PatchEffective;
    messagesLen: number;
  };
}

// ─── Builder & sender ────────────────────────────────────────────────────────

export interface BuildL3ReportInput {
  stage: L3TriggerStage;
  triggerReason: string;
  stateManager: OffloadStateManager;
  event?: unknown;
  contextWindow: number;
  mildThreshold: number;
  aggressiveThreshold: number;
  tokensBefore: number;
  tokensAfter: number;
  messagesBefore: number;
  messagesAfter: number;
  durationMs: number;
  aboveMild: boolean;
  aboveAggressive: boolean;
  mildReplacedCount?: number;
  aggressiveDeletedCount?: number;
  emergencyTriggered?: boolean;
  emergencyDeletedCount?: number;
}

export function buildL3TriggerReport(input: BuildL3ReportInput): L3TriggerReport {
  const {
    stage,
    triggerReason,
    stateManager,
    event,
    contextWindow,
    mildThreshold,
    aggressiveThreshold,
    tokensBefore,
    tokensAfter,
    messagesBefore,
    messagesAfter,
    durationMs,
    aboveMild,
    aboveAggressive,
    mildReplacedCount = 0,
    aggressiveDeletedCount = 0,
    emergencyTriggered = false,
    emergencyDeletedCount = 0,
  } = input;

  const tokensSaved = Math.max(0, tokensBefore - tokensAfter);
  const netTokensSaved = tokensSaved;
  const patch = { status: "n/a" as PatchEffective, messagesLen: 0 };

  // ── Cumulative update (side effect — counters persist across triggers) ──
  _counters.totalTokensSaved += tokensSaved;
  _counters.totalNetTokensSaved += netTokensSaved;
  _counters.totalL3Triggers += 1;
  _counters.totalL3TriggersByStage[stage] =
    (_counters.totalL3TriggersByStage[stage] ?? 0) + 1;
  _counters.totalAggressiveDeleted += aggressiveDeletedCount;
  _counters.totalMildReplaced += mildReplacedCount;
  if (emergencyTriggered) _counters.totalEmergencyTriggered += 1;
  _counters.totalEmergencyDeleted += emergencyDeletedCount;

  // Safe read: stateManager is private-field-heavy, use only public getters.
  let activeMmdFile: string | null = null;
  try { activeMmdFile = stateManager.getActiveMmdFile?.() ?? null; } catch { /* ignore */ }
  let sessionKey: string | null = null;
  try { sessionKey = stateManager.getLastSessionKey?.() ?? null; } catch { /* ignore */ }
  let pendingCount = 0;
  try { pendingCount = stateManager.getPendingCount?.() ?? 0; } catch { /* ignore */ }

  return {
    reportType: REPORT_TYPE_L3,
    reportedAt: nowChinaISO(),
    sessionKey,
    stage,
    triggerReason,
    pluginState: {
      activeMmdFile,
      l15Settled: stateManager.l15Settled === true,
      pendingCount,
      confirmedOffloadCount: stateManager.confirmedOffloadIds?.size ?? 0,
      deletedOffloadCount: stateManager.deletedOffloadIds?.size ?? 0,
    },
    recent: {
      tokensBefore,
      tokensAfter,
      tokensSaved,
      netTokensSaved,
      messagesBefore,
      messagesAfter,
      messagesRemoved: Math.max(0, messagesBefore - messagesAfter),
      durationMs,
    },
    thresholds: {
      contextWindow,
      mildThreshold,
      aggressiveThreshold,
      fixedPatchCostTokens: 0,
      utilisationBeforePct: contextWindow > 0 ? +((tokensBefore / contextWindow) * 100).toFixed(2) : 0,
      utilisationAfterPct: contextWindow > 0 ? +((tokensAfter / contextWindow) * 100).toFixed(2) : 0,
    },
    compression: {
      aboveMild,
      aboveAggressive,
      mildReplacedCount,
      aggressiveDeletedCount,
      emergencyTriggered,
      emergencyDeletedCount,
    },
    cumulative: getCumulativeCounters(),
    patch,
  };
}

 * Fire-and-forget upload of an L3 report to the backend store endpoint.
 * Must never throw — rejection is logged at warn level only.
 */
export function reportL3Trigger(
  backendClient: BackendClient | null,
  report: L3TriggerReport,
  logger: PluginLogger,
): void {
  if (!backendClient) return;
  try {
    backendClient
      .storeState(report as unknown as StoreStatePayload)
      .then(() => {
        logger.debug?.(
          `[context-offload] state-report OK: stage=${report.stage} reason=${report.triggerReason} ` +
          `recentSaved=${report.recent.tokensSaved} cumSaved=${report.cumulative.totalTokensSaved} ` +
          `toolCalls=${report.cumulative.totalToolCalls} patch=${report.patch.status}`,
        );
      })
      .catch((err) => {
        logger.warn(`[context-offload] state-report FAILED: stage=${report.stage} — ${err}`);
      });
  } catch (err) {
    logger.warn(`[context-offload] state-report schedule FAILED: ${err}`);
  }
}