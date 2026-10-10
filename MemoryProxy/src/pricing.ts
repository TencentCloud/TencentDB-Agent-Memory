/**
 * Credit pricing lookup for LLM usage → cost calculation.
 *
 * TDAI 下发的计费规则以 Credit / 1K Token 为单位，按不同 token 类型
 * (input / output / cacheRead / cacheWrite5m / cacheWrite1h) 分别定价。
 * 定价表放在 config.yaml 的 `creditPricing.models`，支持热更新。
 *
 * 匹配规则（`getModelPricing`）：
 *   大小写不敏感的全词匹配 —— modelId 与 config.name 忽略大小写后必须完全相等。
 *   未匹配时返回 null，调用方降级为 raw token count。
 */

import type {
  CreditPricingConfig,
  CreditPricingEntry,
  PricingRule,
  PricingWeekday,
  TieredPricing,
} from "./types.js";

/**
 * Look up model pricing by case-insensitive full-word match.
 *
 * @param config - Credit pricing configuration (from config.yaml).
 * @param modelId - Model identifier (usually the `model` field from usage).
 * @returns Matched pricing entry, or `null` if no match.
 */
export function getModelPricing(
  config: CreditPricingConfig | null | undefined,
  modelId: string | null | undefined,
): CreditPricingEntry | null {
  if (!config?.models?.length || !modelId) return null;

  const lower = modelId.toLowerCase();
  return config.models.find((m) => m.name.toLowerCase() === lower) ?? null;
}

/**
 * 解析 model 的展示名（用于 UI/报表）。
 *
 * 匹配逻辑：
 * 1. `modelId` 空/null/undefined → 返回 `""`
 * 2. 定价表命中且 entry.modelName 非空 → 返回 entry.modelName（如 "Claude Sonnet 4"）
 * 3. 定价表未命中 或 命中但 modelName 未配置/为空 → **回落 modelId 本身**
 *    （前端始终有非空展示；unknown model 至少能看到内部 ID）
 *
 * 与 `getModelPricing` 共用一份匹配逻辑（大小写不敏感全词匹配）。
 *
 * @param config - Credit pricing configuration.
 * @param modelId - Model identifier from usage.
 * @returns 展示名字符串（永远非 null，可能为 ""）。
 */
export function resolveModelName(
  config: CreditPricingConfig | null | undefined,
  modelId: string | null | undefined,
): string {
  if (!modelId) return "";
  const entry = getModelPricing(config, modelId);
  return entry?.modelName || modelId;
}

/** Normalizes a client-facing model name for comparison without changing its display casing. */
export function normalizePublicModelName(modelName: string | null | undefined): string {
  return modelName?.trim().toLowerCase() ?? "";
}

/**
 * 反向解析：把客户端侧的展示名（`modelName`）翻译回真实 `model_id`（`entry.name`）。
 *
 * 客户端展示名与价目表展示名均以去除首尾空白、大小写不敏感的方式匹配；这与
 * `/v1/models` 返回的 ID 保持一致，确保发现到的模型可以直接调用。
 */
export function resolveModelId(
  config: CreditPricingConfig | null | undefined,
  requested: string | null | undefined,
): string {
  if (!requested) return requested ?? "";
  if (!config?.models?.length) return requested;

  const normalizedRequested = normalizePublicModelName(requested);
  if (!normalizedRequested) return requested;
  const entry = config.models.find((m) => {
    const normalizedModelName = normalizePublicModelName(m.modelName);
    return !!normalizedModelName && normalizedModelName === normalizedRequested;
  });
  return entry?.name || requested;
}

/**
 * 校验客户端请求的 `model` 是否已在价目表的 **`modelName`（展示名）** 中登记。
 *
 * 用于请求入口的门禁：价目表配置存在时，客户端只能用展示名（`modelName`）
 * 请求，真实 `model_id`（`entry.name`）视为内部细节，不再作为公开入口。
 * 未匹配的 model 一律拒绝，避免"转发成功但无法计费"的静默漏计费问题。
 *
 * 规则：
 * 1. `config` / `config.models` 为空 → **返回 true**（价目表未配置时跳过校验，
 *    向后兼容旧部署；由 `computeCreditDelta` 走 raw 追溯路径处理）。
 * 2. `requested` 空/null/undefined → **返回 false**（必须显式提供 model 才允许放行）。
 * 3. 命中任意 entry 的**非空** `modelName`（大小写不敏感全词匹配）→ true。
 * 4. 否则 → false。
 *
 * 注：未配置 `modelName` 的 entry 不可被客户端请求命中（此时该模型属"内部专用"，
 * 仅供内部转发使用，不对客户端暴露）。
 *
 * @param config - Credit pricing configuration.
 * @param requested - 客户端请求中的 `model` 字段值。
 * @returns 是否允许放行。
 */
export function isModelInPricing(
  config: CreditPricingConfig | null | undefined,
  requested: string | null | undefined,
): boolean {
  // 价目表未配置：跳过校验（向后兼容）
  if (!config?.models?.length) return true;
  // 显式要求非空 model
  if (!requested) return false;

  const normalizedRequested = normalizePublicModelName(requested);
  if (!normalizedRequested) return false;
  return config.models.some((m) => {
    const normalizedModelName = normalizePublicModelName(m.modelName);
    return !!normalizedModelName && normalizedModelName === normalizedRequested;
  });
}

/** Pricing rates used for credit calculation (subset of PricingTier). */
export interface EffectivePricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** Billing rules are defined in Beijing time and must not be configurable. */
const BEIJING_TIMEZONE = "Asia/Shanghai";
const WEEKDAY_BY_SHORT_NAME: Record<string, PricingWeekday> = {
  Sun: "sun",
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
};

/**
 * Select the time-based rule that applies to this request.
 *
 * Rules are evaluated by descending priority; ties preserve YAML order. If no
 * rule matches (or no rules are configured), the entry's legacy top-level
 * pricing is used, preserving all existing configurations.
 */
export function resolveRulePricing(
  config: CreditPricingConfig | null | undefined,
  entry: CreditPricingEntry,
  requestTime: Date = new Date(),
): TieredPricing {
  return resolveRulePricingDetail(config, entry, requestTime).pricing;
}

export interface ResolvedRulePricing {
  pricing: TieredPricing;
  ruleId?: string;
  timezone: string;
}

/** Select a time rule and retain its audit metadata. */
export function resolveRulePricingDetail(
  _config: CreditPricingConfig | null | undefined,
  entry: CreditPricingEntry,
  requestTime: Date = new Date(),
): ResolvedRulePricing {
  const timezone = BEIJING_TIMEZONE;
  if (!entry.rules?.length) return { pricing: entry, timezone };

  const localTime = getLocalPricingTime(requestTime);
  const matchingRule = entry.rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => (b.rule.priority ?? 0) - (a.rule.priority ?? 0) || a.index - b.index)
    .find(({ rule }) => ruleMatches(rule, localTime));

  return matchingRule
    ? { pricing: matchingRule.rule.pricing, ruleId: matchingRule.rule.id, timezone }
    : { pricing: entry, timezone };
}

function getLocalPricingTime(requestTime: Date): { weekday: PricingWeekday; minuteOfDay: number } {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: BEIJING_TIMEZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = format.formatToParts(requestTime);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = WEEKDAY_BY_SHORT_NAME[values.weekday] ?? "sun";
  return {
    weekday,
    minuteOfDay: Number(values.hour ?? 0) * 60 + Number(values.minute ?? 0),
  };
}

function ruleMatches(rule: PricingRule, localTime: { weekday: PricingWeekday; minuteOfDay: number }): boolean {
  const when = rule.when;
  if (!when) return true;
  if (when.weekdays?.length && !when.weekdays.includes(localTime.weekday)) return false;
  if (!when.timeRanges?.length) return true;
  return when.timeRanges.some((range) => {
    const start = parseTime(range.start);
    const end = parseTime(range.end);
    if (start === null || end === null || start === end) return false;
    return start < end
      ? localTime.minuteOfDay >= start && localTime.minuteOfDay < end
      : localTime.minuteOfDay >= start || localTime.minuteOfDay < end;
  });
}

function parseTime(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * 按 input token 总量选择生效的定价档位。
 *
 * 匹配规则：升序遍历 `entry.tiers`，第一个满足
 * `totalInputTokens ≤ tier.maxInputTokens`（或 `maxInputTokens == null`）的即命中。
 * 命中后该请求**所有 token 类型**都按该档单价计费（整体定档，非分段累进）。
 *
 * 无 `tiers` 或数组为空时直接返回 entry 顶层单价（向后兼容）。
 *
 * @param entry - 命中的模型定价条目。
 * @param totalInputTokens - 分档判据 = nonCacheInput + cacheRead。
 */
export function resolveTierPricing(
  entry: TieredPricing,
  totalInputTokens: number,
): EffectivePricing {
  if (!entry.tiers?.length) return entry;

  for (const tier of entry.tiers) {
    if (tier.maxInputTokens == null || totalInputTokens <= tier.maxInputTokens) {
      return tier;
    }
  }
  // 所有档都没命中（理论上不会，最后一档应是 null）→ 回落顶层
  return entry;
}
