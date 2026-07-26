/**
 * Where the stable system context is placed in the OpenClaw prompt.
 *
 * Issue #120 (secondary root cause): the plugin's stable content — persona,
 * scene navigation, memory-tools guide, ~4k chars — was emitted as
 * `appendSystemContext`, which the host concatenates *after* its
 * `CACHE_BOUNDARY` marker.  Content after the boundary is outside the
 * reusable prefix, so those tokens are billed fresh on every turn even
 * though the bytes never change.  Moving the block ahead of the boundary
 * lets prefix-matching providers (DeepSeek, MiMo) reuse it.
 *
 * The host field that lands before the boundary (`prependSystemContext`) is
 * newer than the field that lands after it (`appendSystemContext`).  A host
 * that does not implement the newer field simply ignores the unknown key, so
 * emitting only `prependSystemContext` would make persona and scene
 * navigation vanish entirely on older hosts — a silent, total loss of L3/L2
 * injection rather than a cache regression.
 *
 * This module therefore treats the version gate as a *performance* gate, not
 * a correctness gate:
 *
 *   - the stable text is emitted exactly once, on every code path;
 *   - when the host cannot be confirmed to support the prefix field, it is
 *     emitted through the legacy suffix field instead;
 *   - a wrong version guess costs cache reuse, never content.
 *
 * `shapeOpenClawSystemContext` is written so that violating the
 * exactly-once property is not expressible: it selects a single target key.
 */

import type { StableContextPlacement } from "../../config.js";
import {
  compareVersionXYZ,
  parseVersionXYZ,
} from "../../utils/ensure-hook-policy.js";

export type { StableContextPlacement };

/**
 * Earliest host version we treat as supporting a system-prompt addition that
 * lands before `CACHE_BOUNDARY`.
 *
 * This threshold only decides whether the stable block is eligible for the
 * reusable prefix.  Because the fallback is lossless, setting it too high
 * costs cache reuse and setting it too low costs nothing beyond the host
 * ignoring an unknown key while the suffix path still carries the text.
 */
export const SYSTEM_PREFIX_MIN_VERSION: readonly [number, number, number] = [
  2026, 4, 27,
];

/** Placement actually used for a turn. */
export type EffectiveStableContextPlacement = "systemPrefix" | "systemSuffix";

export interface StableContextPlacementDecision {
  requested: StableContextPlacement;
  effective: EffectiveStableContextPlacement;
  hostVersion: [number, number, number] | null;
  /** Present only when `auto` could not be honoured as `systemPrefix`. */
  fallbackReason?: "unknown-host-version" | "system-prefix-unsupported";
}

/** Minimal shape this module needs; extra keys pass through untouched. */
export interface StableContextCarrier {
  /** Host-neutral stable block produced by the recall core. */
  appendSystemContext?: string;
}

export interface OpenClawSystemContextFields {
  /** Stable block placed before the host cache boundary. */
  prependSystemContext?: string;
  /** Stable block placed after the host cache boundary (legacy path). */
  appendSystemContext?: string;
}

/**
 * Decide where the stable block should go.
 *
 * `auto` resolves to `systemPrefix` only when the host reports a version at
 * or above {@link SYSTEM_PREFIX_MIN_VERSION}.  An unparsable or absent
 * version resolves to the legacy suffix, because hosts old enough to lack
 * the prefix field commonly predate `api.runtime.version` itself.
 *
 * Explicit `systemPrefix` / `systemSuffix` are honoured verbatim so an
 * operator who knows their host can opt in ahead of the version table.
 */
export function resolveStableContextPlacement(
  requested: StableContextPlacement,
  rawHostVersion: unknown,
): StableContextPlacementDecision {
  const hostVersion = parseVersionXYZ(rawHostVersion);

  if (requested === "systemPrefix" || requested === "systemSuffix") {
    return { requested, effective: requested, hostVersion };
  }

  if (!hostVersion) {
    return {
      requested,
      effective: "systemSuffix",
      hostVersion,
      fallbackReason: "unknown-host-version",
    };
  }

  if (compareVersionXYZ(hostVersion, SYSTEM_PREFIX_MIN_VERSION) < 0) {
    return {
      requested,
      effective: "systemSuffix",
      hostVersion,
      fallbackReason: "system-prefix-unsupported",
    };
  }

  return { requested, effective: "systemPrefix", hostVersion };
}

/**
 * Route the stable block to exactly one host field.
 *
 * Returns the input unchanged when there is no stable text, so a turn that
 * only carries dynamic recall is untouched.  Otherwise the source key is
 * removed and re-emitted under the chosen key, which makes duplication
 * structurally impossible.
 */
export function shapeOpenClawSystemContext<T extends StableContextCarrier>(
  result: T | undefined,
  placement: EffectiveStableContextPlacement,
): (T & OpenClawSystemContextFields) | undefined {
  if (!result) return result;

  const stableText = result.appendSystemContext;
  if (!stableText) return result as T & OpenClawSystemContextFields;

  const { appendSystemContext: _dropped, ...rest } = result;
  return placement === "systemPrefix"
    ? ({ ...rest, prependSystemContext: stableText } as T & OpenClawSystemContextFields)
    : ({ ...rest, appendSystemContext: stableText } as T & OpenClawSystemContextFields);
}

/**
 * Read back the stable text regardless of which field carries it.
 *
 * Used by non-OpenClaw consumers (Gateway/Hermes) and by tests asserting the
 * exactly-once property.
 */
export function readStableSystemContext(
  fields: OpenClawSystemContextFields | undefined,
): { text?: string; carriedBy: Array<"prependSystemContext" | "appendSystemContext"> } {
  const carriedBy: Array<"prependSystemContext" | "appendSystemContext"> = [];
  if (fields?.prependSystemContext) carriedBy.push("prependSystemContext");
  if (fields?.appendSystemContext) carriedBy.push("appendSystemContext");
  return {
    text: fields?.prependSystemContext ?? fields?.appendSystemContext,
    carriedBy,
  };
}
