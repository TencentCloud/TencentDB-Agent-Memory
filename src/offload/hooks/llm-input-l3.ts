/**
 * llm-input-l3.ts — Backward-compat shim (Group D decomposition).
 * Re-exports the public API from `llm-input-l3/*.ts` sub-modules. The
 * 1412-line monolithic file was split into:
 *   - filter-heartbeat.ts
 *   - overflow-detect.ts
 *   - score-cascade.ts + score-cascade-constants.ts + score-cascade-replace.ts
 *   - user-protection.ts
 *   - aggressive-compress.ts
 *   - emergency-compress.ts + emergency-tail-delete.ts + emergency-truncate.ts + emergency-helpers.ts
 *   - mmd-injection.ts
 *   - fastpath.ts
 *   - handler.ts + handler-aggressive.ts + handler-finalize.ts
 * Callers that did `import { ... } from "./llm-input-l3.js"` continue to work.
 */

// Heartbeat filtering
export { filterHeartbeatMessages } from "./llm-input-l3/filter-heartbeat.js";

// Token overflow detection + dump helper + EMERGENCY_TRUNCATE_MAX_CHARS
export { isTokenOverflowError, dumpMessagesSnapshot, EMERGENCY_TRUNCATE_MAX_CHARS } from "./llm-input-l3/overflow-detect.js";

// L3 mild / aggressive / emergency constants
export { MILD_CASCADE_MIN_COUNT, MILD_CASCADE_INITIAL_SCORE, MILD_CASCADE_FLOOR_SCORE, AGGRESSIVE_MIN_MESSAGES_TO_KEEP, EMERGENCY_MIN_MESSAGES_TO_KEEP } from "./llm-input-l3/score-cascade-constants.js";

// Mild score-cascade compression
export { compressByScoreCascade } from "./llm-input-l3/score-cascade.js";

// Aggressive one-shot compression
export { aggressiveCompressUntilBelowThreshold, computeAggressiveDeleteCount, adjustDeleteCountForToolPairing } from "./llm-input-l3/aggressive-compress.js";

// Emergency compression + tail-delete + truncate fallbacks
export { emergencyCompress } from "./llm-input-l3/emergency-compress.js";
export { _emergencyTailDelete } from "./llm-input-l3/emergency-tail-delete.js";
export { _emergencyTruncateOversized } from "./llm-input-l3/emergency-truncate.js";

// History MMD injection
export { removeExistingMmdInjections, buildHistoryMmdInjection, buildHistoryMmdText, buildHistoryMmdMetaText } from "./llm-input-l3/mmd-injection.js";

// Fast-path re-apply + latest turn extraction
export { fastPathReApply, extractLatestTurn, extractMsgText } from "./llm-input-l3/fastpath.js";

// User message protection
export { findLastUserMessageIndex, capDeleteCountForUserMessage } from "./llm-input-l3/user-protection.js";

// Main L3 handler factory
export { createLlmInputL3Handler } from "./llm-input-l3/handler.js";
