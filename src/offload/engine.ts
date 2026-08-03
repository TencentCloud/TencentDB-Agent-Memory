/**
 * engine.ts — OffloadContextEngine class + module-level singletons.
 *
 * Singletons (L2 scheduler state, L1.5 dispose flag, engine singleton,
 * session registry singleton) are wrapped in a state object so they can
 * be mutated from other modules (ESM forbids reassignment of imported
 * `let` bindings).
 *
 * The class body delegates assemble() and compact() to functions in
 * engine-assemble.ts / engine-compact.ts to keep this file ≤150 lines.
 *
 * Extracted from index.ts (Group D decomposition).
 */
import { SessionRegistry } from "./session-registry.js";
import type { OffloadStateManager } from "./state-manager.js";
import type { BackendClient } from "./backend-client.js";
import type { PluginConfig, PluginLogger } from "./types.js";
import { isInternalMemorySession } from "./engine-helpers.js";
import { runAssemblePipeline } from "./engine-assemble.js";
import { runCompactPipeline } from "./engine-compact.js";

/**
 * Module-level singletons wrapped in an object for ESM-compatible mutation
 * from sibling files. ALL consumers must read/write through this object.
 */
export const engineState = {
  l2Running: false as boolean,
  l2PollHandle: null as ReturnType<typeof setTimeout> | null,
  l2FirstNotifyAt: null as number | null,
  l15Disposed: false as boolean,
  reclaimTimer: null as ReturnType<typeof setTimeout> | null,
  sharedEngine: null as OffloadContextEngine | null,
  contextEngineRegistered: false as boolean,
  contextEngineRejected: false as boolean,
  sharedSessions: null as SessionRegistry | null,
};

export class OffloadContextEngine {
  private _sessions: SessionRegistry;
  private _logger: PluginLogger;
  private _pCfg: Partial<PluginConfig>;
  private _getContextWindow: () => number;
  private _notifyL2NewNullEntries: (count: number) => void;
  private _clearL2Timeout: () => void;
  private _l4State: { pendingResult: any };
  private _flushL1: (mgr: OffloadStateManager, triggerSource: string, fireAndForget?: boolean, maxCount?: number) => Promise<void>;
  private _backendClient: BackendClient | null;
  private _judgeL15: (mgr: OffloadStateManager, event: any, ctx: any) => Promise<void>;
  private _disposeL15: () => void;

  constructor(opts: any) { this.update(opts); }

  /** Hot-update all internal references (called on every registerOffload). */
  update(opts: any): void {
    this._sessions = opts.sessions;
    this._logger = opts.logger;
    this._pCfg = opts.pCfg;
    this._getContextWindow = opts.getContextWindow;
    this._notifyL2NewNullEntries = opts.notifyL2NewNullEntries;
    this._clearL2Timeout = opts.clearL2Timeout;
    this._l4State = opts.l4State;
    this._flushL1 = opts.flushL1;
    this._backendClient = opts.backendClient;
    this._judgeL15 = opts.judgeL15;
    this._disposeL15 = opts.disposeL15 ?? (() => {});
  }

  get info() {
    return { id: "openclaw-context-offload", name: "Context Offload Engine", version: "0.7.0", ownsCompaction: true };
  }

  async bootstrap(params: any) {
    const { sessionId, sessionKey } = params;
    const logger = this._logger;
    logger.debug?.(`[context-offload] >>> CE.bootstrap CALLED: sessionKey=${sessionKey}, sessionId=${sessionId?.slice(0, 12)}...`);
    if (isInternalMemorySession(sessionKey)) {
      logger.debug?.(`[context-offload] bootstrap SKIP: internal memory session (${sessionKey})`);
      return { bootstrapped: false, reason: "internal_memory_session" };
    }
    try {
      if (sessionKey) {
        const entry = await this._sessions.resolveIfAllowed(sessionKey, sessionId);
        if (entry) params._offloadManager = entry.manager;
      }
      return { bootstrapped: true };
    } catch (err) {
      return { bootstrapped: false, reason: String(err) };
    }
  }

  async ingest(params: any) {
    const { message } = params;
    if (!message) return { ingested: false };
    const role = message.role ?? message.message?.role;
    if (role === "toolResult" || role === "tool") {
      const toolCallId = message.toolCallId ?? message.tool_call_id ?? message.message?.toolCallId ?? message.message?.tool_call_id;
      if (toolCallId) {
        let mgr: OffloadStateManager | undefined = params._offloadManager;
        if (!mgr && params.sessionKey) mgr = this._sessions.get(params.sessionKey)?.manager;
        if (mgr) mgr.processedToolCallIds.add(toolCallId);
        return { ingested: true };
      }
    }
    return { ingested: false };
  }

  async assemble(params: any) {
    return runAssemblePipeline(this, params);
  }

  async compact(params: any) {
    return runCompactPipeline(this, params);
  }

  async afterTurn(_params: any) {
    const logger = this._logger;
    logger.debug?.(`[context-offload] >>> CE.afterTurn CALLED: sessionKey=${_params?.sessionKey ?? "?"}`);
    let stateManager: OffloadStateManager | undefined = _params?._offloadManager;
    if (!stateManager && _params?.sessionKey && !isInternalMemorySession(_params.sessionKey)) {
      try { const entry = this._sessions.get(_params.sessionKey); stateManager = entry?.manager; } catch { /* ignore */ }
    }
    if (!stateManager) return;
    try {
      const pendingCount = stateManager.getPendingCount();
      if (pendingCount > 0) {
        logger.debug?.(`[context-offload] afterTurn: fire-and-forget flushing ${pendingCount} remaining pending pairs`);
        this._flushL1(stateManager, "afterTurn_flush").then(async () => {
          try {
            const allEntries = await (await import("./storage.js")).readAllOffloadEntries(stateManager!.ctx);
            const nullCount = allEntries.filter((e: any) => e.node_id === null).length;
            if (nullCount > 0) this._notifyL2NewNullEntries(nullCount);
          } catch { /* ignore */ }
        }).catch((err: any) => { logger.warn?.(`[context-offload] afterTurn: L1 flush failed: ${err}`); });
      }
      if (stateManager.isLoaded()) await stateManager.save();
    } catch { /* ignore */ }
  }

  async maintain(_params: any) {
    return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
  }

  async dispose() {
    this._logger.debug?.("[context-offload] dispose: cleaning up");
    this._disposeL15();
    this._clearL2Timeout();
    if (engineState.reclaimTimer !== null) { clearTimeout(engineState.reclaimTimer); engineState.reclaimTimer = null; }
  }
}
