/**
 * src/offload/index.ts — backward-compat shim (Group D decomposition).
 *
 * The 2310-line monolith was split into:
 *   register.ts (+ register-ctx/-flush/-l15/-l2/-l4/-hooks/-hooks-input/-engine)
 *   engine.ts / engine-assemble*.ts / engine-compact.ts / engine-helpers.ts
 *   engine-history-helpers.ts / l2-scheduler.ts / storage.ts (+ storage/)
 *   hooks/llm-input-l3.ts (+ hooks/llm-input-l3/)
 *
 * Public API preserved: registerOffload (repo root index.ts:27 imports it)
 * and _testExports (internal test surface; no consumers).
 */
export { registerOffload } from "./register.js";
import { OffloadContextEngine } from "./engine.js";
import {
  _isHeartbeatText,
  _extractMsgText,
  _normalizePromptForCompare,
  _extractLatestTurn,
  isInternalMemorySession,
  simpleHash,
} from "./engine-helpers.js";
import { _extractRecentHistory, _buildL1RecentContext, _buildL15RecentContext } from "./engine-history-helpers.js";
export { OffloadContextEngine };

/** Test-only exports (internal functions for unit testing). */
export const _testExports = {
  _isHeartbeatText: _isHeartbeatText as unknown as (...args: any[]) => boolean,
  _extractMsgText: _extractMsgText as unknown as (msg: any) => string,
  _normalizePromptForCompare: _normalizePromptForCompare as unknown as (text: string | null) => string,
  _extractLatestTurn: _extractLatestTurn as unknown as (msgs: any[], prompt: string | null) => string | null,
  _extractRecentHistory: _extractRecentHistory as unknown as (msgs: any[], prompt?: string | null, max?: number) => string | null,
  _buildL1RecentContext: _buildL1RecentContext as unknown as (sm: any) => string,
  _buildL15RecentContext: _buildL15RecentContext as unknown as (sm: any) => string,
  isInternalMemorySession: isInternalMemorySession as unknown as (key: string | null | undefined) => boolean,
  simpleHash: simpleHash as unknown as (str: string) => number,
  OffloadContextEngine,
};
