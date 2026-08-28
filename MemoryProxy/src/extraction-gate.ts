/**
 * extraction-gate — the single semantic gate for every write-side
 * (extraction) call site.
 *
 * Motivation:
 *   The read side (injection) has a first-class pipeline + hook registry +
 *   yaml whitelist (`injection.injectors: [...]`). The write side
 *   historically had none — `triggerSkillExtractIfReady` and
 *   `recordTdaiTurn` were sprinkled across handler.ts / anthropicHandler.ts
 *   and had no top-level kill switch. Operators could not "inject but not
 *   extract" without touching source dependencies.
 *
 * Design (intentionally minimal — keep the stable version stable):
 *   - Add ONE yaml section: `extraction: { enabled, extractors: [...] }`.
 *   - Add ONE pure predicate: `isExtractionAllowed(config, asset)`.
 *   - Wrap each existing call site in `if (isExtractionAllowed(...))`.
 *
 * Backwards compatibility is preserved by making the gate PERMISSIVE when
 * the config section is missing or malformed:
 *   - `config.extraction` absent          → allow all (defensive fallback)
 *   - `extractors` field missing          → allow all (partial config)
 *   - `extractors` not an array           → allow all (yaml typo tolerance)
 *   - `enabled: false`                    → deny everything
 *   - `extractors: []`                    → deny everything
 *   - `extractors: ["skill"]`             → allow only "skill"
 *
 * Adding a new extractor asset later means: register it under a stable name
 * here and add one `if (isExtractionAllowed(config, "your-asset"))` at the
 * new call site. No pipeline refactor required.
 */

import { log } from "./report/log.js";
import type { ProxyConfig } from "./types.js";

export function isExtractionAllowed(config: ProxyConfig, asset: string): boolean {
  const ext = config.extraction;
  // Defensive: missing extraction block → keep historical "always on" behavior.
  if (!ext) return true;
  if (ext.enabled === false) return false;
  // Defensive: missing / non-array extractors → treat as unrestricted whitelist
  // so a partial or misconfigured yaml never silently disables writes.
  if (!Array.isArray(ext.extractors)) return true;
  return ext.extractors.includes(asset);
}

/**
 * bypass 会话（跳过 Session Init / 缺 task 预选）的 L0 写入是否允许。
 * 策略见 types.ts TdaiMemoryConfig.bypassWritePolicy：
 *   skip（默认）→ 不写，防无归属内容混入共享记忆；
 *   write-scoped / write → 允许写（scope 由调用方标记）。
 */
export function isMemoryWriteAllowed(config: ProxyConfig, bypassed: boolean): boolean {
  if (!bypassed) return true;
  const policy = config.tdai?.memory?.bypassWritePolicy ?? "skip";
  return policy === "write" || policy === "write-scoped";
}

/**
 * Emit a structured debug event when the gate blocks an extraction call.
 * Call this in the *else* branch of `isExtractionAllowed`. No-ops when the
 * asset would have been allowed anyway (defensive: prevents misleading
 * "skipped" events if a caller forgets the surrounding `if`).
 *
 * Level rationale: emitted at DEBUG level (not INFO) because it fires on
 * every turn once extraction is off and would swamp production log volume.
 * Flip `log.level=debug` when investigating "why isn't extract running?".
 */
export function logExtractionSkipped(
  config: ProxyConfig,
  asset: string,
  sessionKey: string | undefined,
): void {
  // If this asset is actually allowed, do NOT emit a skip event — that would
  // be a lie. This makes the function safe to call unconditionally next to
  // an `if (!isExtractionAllowed(...))` guard without worrying about drift.
  if (isExtractionAllowed(config, asset)) return;

  const ext = config.extraction;
  const reason =
    !ext ? "no-config"                          // won't happen (allowed path)
    : ext.enabled === false ? "disabled"        // extraction.enabled=false
    : "not-in-extractors";                      // asset missing from whitelist
  const session = sessionKey && sessionKey.length > 0 ? sessionKey : "-";
  log.debug("extraction.skipped", { asset, session, reason });
}
