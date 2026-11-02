/**
 * Decision Provider 注册表：provider 类型名 → factory。
 *
 * 内置 `jev`。接入其他 decision API：实现 `DecisionProvider` 后在 `BUILTIN_PROVIDERS`
 * 注册，或在启动时调用 `registerDecisionProvider`（同名覆盖需显式 `override`）。
 */

import { JevClient } from "./providers/jev/client.js";
import type {
  DecisionProvider,
  DecisionProviderDeps,
  DecisionProviderFactory,
  DecisionProviderParams,
} from "./types.js";

const BUILTIN_PROVIDERS: Record<string, DecisionProviderFactory> = {
  jev: (params, deps) =>
    new JevClient(
      { endpoint: params.endpoint, apiKey: params.apiKey, model: params.model, timeoutMs: params.timeoutMs },
      deps.fetcher,
    ),
};

const factories = new Map<string, DecisionProviderFactory>(Object.entries(BUILTIN_PROVIDERS));

/** provider 名约束：小写字母开头，仅含小写字母/数字/`-`/`_`，≤ 32 字符。 */
export const DECISION_PROVIDER_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function registerDecisionProvider(
  name: string,
  factory: DecisionProviderFactory,
  opts: { override?: boolean } = {},
): void {
  if (!DECISION_PROVIDER_NAME_RE.test(name)) {
    throw new Error(`[decision] invalid provider name: ${JSON.stringify(name)}`);
  }
  if (factories.has(name) && !opts.override) {
    throw new Error(`[decision] provider already registered: ${name}`);
  }
  factories.set(name, factory);
}

/** 测试用：移除运行时注册的 provider 并恢复内置项。 */
export function resetDecisionProviders(): void {
  factories.clear();
  for (const [name, factory] of Object.entries(BUILTIN_PROVIDERS)) factories.set(name, factory);
}

export function listDecisionProviders(): string[] {
  return [...factories.keys()].sort();
}

export function hasDecisionProvider(name: string): boolean {
  return factories.has(name);
}

/** 按类型名创建 provider；未注册的类型直接抛错（启动期暴露配置错误）。 */
export function createDecisionProvider(
  name: string,
  params: DecisionProviderParams,
  deps: DecisionProviderDeps = {},
): DecisionProvider {
  const factory = factories.get(name);
  if (!factory) {
    throw new Error(
      `[decision] unknown provider "${name}"; available: ${listDecisionProviders().join(", ")}`,
    );
  }
  return factory(params, deps);
}
