/**
 * 注入微调（A/B）解析：把 `injection.tuning` 解析成针对当前客户端的
 * 覆盖结果 —— `default` 为全局默认，`perAgent[<agentSource>]` 逐客户端覆盖。
 * 返回的对象只含已覆盖字段（undefined 表示未覆盖）。
 */
import type { InjectionTuningConfig, InjectionTuningOverrides } from "../types.js";

export function resolveInjectionTuning(
  tuning: InjectionTuningConfig | undefined,
  agentSource: string | undefined,
): InjectionTuningOverrides {
  const out: InjectionTuningOverrides = {};
  if (tuning?.default) {
    Object.assign(out, tuning.default);
  }
  if (agentSource && tuning?.perAgent?.[agentSource]) {
    Object.assign(out, tuning.perAgent[agentSource]);
  }
  return out;
}
