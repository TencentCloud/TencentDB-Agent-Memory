/**
 * 选择策略注册表：策略名 → 策略实例。与资产无关，skill / memory 等适配层共用。
 *
 * 解析顺序（`createSelectionStrategy(name, strategies)`）：
 *   1. 运行时注册的自定义策略（`registerSelectionStrategy`）—— 完全自定义决策逻辑
 *   2. 配置里的 `selection.strategies.<name>` —— 通用 choice 策略 + 其 `provider`
 *      指定的 decision provider（内置 jev；其他 decision API 见 `src/decision/registry.ts`）
 *   3. 都没有 → 抛错（启动期暴露配置错误）
 *
 * 绝大多数场景只需新增 decision provider，不需要新增策略。
 */

import type { SelectionStrategiesConfig, SelectionStrategyConfig } from "../types.js";
import { createDecisionProvider } from "../decision/registry.js";
import type { DecisionProviderDeps } from "../decision/types.js";
import type { SelectionStrategy } from "./types.js";
import { ChoiceSelectionStrategy } from "./strategies/choice.js";

export type SelectionStrategyFactory = (strategies: SelectionStrategiesConfig) => SelectionStrategy;

const factories = new Map<string, SelectionStrategyFactory>();

/** 策略名约束：小写字母开头，仅含小写字母/数字/`-`/`_`，≤ 32 字符。 */
export const STRATEGY_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** 由一项策略配置构造通用 choice 策略（provider 由配置决定）。 */
export function createChoiceStrategy(
  name: string,
  cfg: SelectionStrategyConfig,
  deps: DecisionProviderDeps = {},
): ChoiceSelectionStrategy {
  const provider = createDecisionProvider(
    cfg.provider || "jev",
    { endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model, timeoutMs: cfg.timeoutMs, options: cfg.options },
    deps,
  );
  return new ChoiceSelectionStrategy(provider, { name, minConfidence: cfg.minConfidence });
}

export function registerSelectionStrategy(
  name: string,
  factory: SelectionStrategyFactory,
  opts: { override?: boolean } = {},
): void {
  if (!STRATEGY_NAME_RE.test(name)) {
    throw new Error(`[selection] invalid strategy name: ${JSON.stringify(name)}`);
  }
  if ((factories.has(name) || name === "jev") && !opts.override) {
    throw new Error(`[selection] strategy already registered: ${name}`);
  }
  factories.set(name, factory);
}

/** 测试用：移除运行时注册的策略。 */
export function resetSelectionStrategies(): void {
  factories.clear();
}

/** 已知策略名：内置 jev + 运行时注册 + （传入时）配置里定义的策略。 */
export function listSelectionStrategies(strategies?: SelectionStrategiesConfig): string[] {
  const names = new Set<string>(["jev", ...factories.keys(), ...Object.keys(strategies ?? {})]);
  return [...names].sort();
}

export function hasSelectionStrategy(name: string, strategies?: SelectionStrategiesConfig): boolean {
  return name === "jev" || factories.has(name) || !!strategies?.[name];
}

/** 按名创建策略；未定义的策略名或未注册的 provider 直接抛错。 */
export function createSelectionStrategy(
  name: string,
  strategies: SelectionStrategiesConfig,
): SelectionStrategy {
  const factory = factories.get(name);
  if (factory) return factory(strategies);
  const cfg = strategies[name];
  if (cfg) return createChoiceStrategy(name, cfg);
  throw new Error(
    `[selection] unknown strategy "${name}"; available: ${listSelectionStrategies(strategies).join(", ")}`,
  );
}
