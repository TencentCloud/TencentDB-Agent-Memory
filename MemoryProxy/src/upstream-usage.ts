/**
 * upstream-usage.ts — 自定义上游（custom upstream）用量统计。
 *
 * ============================================================================
 * 「这一项」的计算口径（统计 / 计费）— 完整定义
 * ============================================================================
 *
 * 本模块统计的对象：**命中 instance-upstream 自定义分组（custom group）的请求**。
 * 这类请求在转发时会被 `stageInstanceUpstreamOverride` 改写 base_url / api_key /
 * model_id，并置 `skipCreditReport = true`。
 *
 * ── 它参与哪些环节 ────────────────────────────────────────────────────────
 *
 *   1. **用量统计（本模块）— 完整纳入** ✅
 *      统计维度：spaceId × agent（agent_source）× 分组（group_id / name）× model_id
 *      统计指标：requests、5 类 token（nonCacheInput / output / cacheRead /
 *                cacheWrite5m / cacheWrite1h）、等价 credit、无法折价的 token 量
 *
 *   2. **平台计费（MemoryPlus CreditDelta 上报）— 不纳入** ❌
 *      原因：custom upstream 的 base_url / api_key 由用户自备，费用由用户与
 *      其自有供应商结算，平台不出账。
 *      代码位置：pipeline/stages/credit.ts 的 `skipCreditReport` 短路分支；
 *                pipeline/runners/utility.ts 的 `skipCreditReport` 分支；
 *                pipeline/stages/instance-upstream-override.ts 的返回字段。
 *      因此 `equivalentCredit` 只是**按本平台价目表折算的参考值**（"如果这笔
 *      流量走平台官方通道要花多少钱"），**不是账单金额**，绝不可与已上报的
 *      CreditDelta 混加。
 *
 * ── 计算口径与公式 ────────────────────────────────────────────────────────
 *
 *   输入数据来源：
 *     - usage          上游响应体里的 usage 对象（与计费侧同一份，未加工）
 *     - upstreamUrl    实际转发地址（用于判定 usage 协议分支）
 *     - modelId        **override 后的**生效 model_id（row.model_id || 原 modelId）
 *     - pricing        config.creditPricing（价目表，热更新）
 *     - requestTime    请求开始时间（用于时段规则 rules 判定，北京时间）
 *
 *   协议分支（与 credit-reporter.detectUsageProtocol 完全一致）：
 *     - /v1/messages            → anthropic：input_tokens 已扣缓存
 *     - /v1/responses           → responses：input_tokens 含缓存
 *     - 其它（chat/completions）→ openai：prompt_tokens 含缓存
 *
 *   Token 五分类：
 *     nonCacheInput = anthropic ? input_tokens
 *                              : max(0, input|prompt_tokens - cacheRead)
 *     output        = completion_tokens || output_tokens
 *     cacheRead     = cache_read_input_tokens
 *                   || cache_read_tokens
 *                   || prompt_tokens_details.cached_tokens
 *                   || input_tokens_details.cached_tokens
 *     cacheWrite5m  = cache_creation.ephemeral_5m_input_tokens
 *                     + 无 TTL 明细的 cache_creation_input_tokens 余额
 *                   || cache_write_tokens || prompt_cache_write_tokens
 *     cacheWrite1h  = cache_creation.ephemeral_1h_input_tokens（responses/openai 无）
 *
 *   等价 credit 公式（每 1K token，与 computeCreditDelta 逐项一致）：
 *     equivalentCredit =
 *         (nonCacheInput / 1000) * P.input
 *       + (output       / 1000) * P.output
 *       + (cacheRead    / 1000) * P.cacheRead
 *       + (cacheWrite5m / 1000) * P.cacheWrite5m
 *       + (cacheWrite1h / 1000) * P.cacheWrite1h
 *     其中 P 由 价目表匹配(modelId) → 时段规则(rules, 北京时间, priority 降序)
 *           → 分档(tiers, 判据 totalInput = nonCacheInput + cacheRead) 三级解析得出。
 *
 * ── 边界条件与例外场景（不纳入计算的部分）─────────────────────────────────
 *
 *   E1. usage 为空 / 上游返回非 2xx → 不计入（无用量可计）。
 *   E2. usage 里全是 0（上游未回传用量）→ 计入 requests，token 记 0。
 *   E3. modelId 未登记在价目表 → equivalentCredit = 0，但该笔 token 累加进
 *       `unpricedTokens`，保证"用了多少"不丢，只是无法折价。
 *       （与计费侧 unknown_model 落 raw 表的处理一致：宁可不计价也不失真。）
 *   E4. 流式响应上游未回传 usage（如只发 [DONE]）→ 同 E1，不计入。
 *   E5. 非 custom 组请求（official / default 组）→ **完全不进本模块**，它们走
 *       正常计费上报链路，避免重复计数。
 *   E6. dsh headless / auxiliary（compaction、title、count_tokens、embeddings）
 *       等请求 → 由调用方保证不传（本模块不做二次判定）。
 *   E7. 本统计是**进程内存态**，重启即清零；不做持久化、不参与对账。
 *       仅用于运维可观测与"这一项的贡献可见"，不可作为结算依据。
 */

import { getModelPricing, resolveRulePricingDetail, resolveTierPricing } from "./pricing.js";
import type { CreditPricingConfig } from "./types.js";

/** 统计维度键：spaceId × agent × 分组 × 模型（P4：+ team 归属） */
export interface UsageKey {
  spaceId: string;
  agent: string;
  groupId: string;
  groupName: string;
  model: string;
  /** 团队归属（P4）：空 = 全局组流量 */
  teamId: string;
}

/** 单项统计累计值 */
export interface UsageAccum {
  requests: number;
  /** 非缓存输入 token */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** 按价目表折算的等价 credit（**非账单金额**，仅参考） */
  equivalentCredit: number;
  /** 价目表未登记导致无法折价的 token 总量（input+output，用于 E3 可见化） */
  unpricedTokens: number;
  /** 最近一次记录时间（ISO） */
  lastAt: string;
}

export interface CustomUpstreamUsageInput {
  usage: Record<string, unknown> | null | undefined;
  upstreamUrl: string | undefined;
  modelId: string | undefined;
  spaceId: string;
  agent: string;
  groupId: string;
  groupName: string;
  /** 团队归属（P4） */
  teamId: string;
  pricing: CreditPricingConfig | null | undefined;
  requestTime?: Date;
}

// ── 内存态存储 ─────────────────────────────────────────────────────────────
// 见 E7：进程内存，重启清零。容量上限做硬保护，防止维度爆炸吃满内存。

const MAX_KEYS = 512;
const store = new Map<string, UsageAccum>();

function keyOf(k: UsageKey): string {
  // 6 段：spaceId | agent | groupId | groupName | model | teamId
  return `${k.spaceId}|${k.agent}|${k.groupId}|${k.groupName}|${k.model}|${k.teamId}`;
}

function numField(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * 判定 usage 的协议分支（与 credit-reporter.detectUsageProtocol 同口径）。
 * 私有副本是为了让统计侧不依赖计费侧的 tokenhub 短路逻辑。
 */
function detectProtocol(upstreamUrl: string): "anthropic" | "openai" | "responses" {
  const path = upstreamUrl.toLowerCase();
  if (/\/v1\/messages(\/|\?|$)/.test(path)) return "anthropic";
  if (/\/v1\/responses(\/|\?|$)/.test(path) || /\/responses(\/|\?|$)/.test(path)) return "responses";
  return "openai";
}

/** 把上游 usage 拆成 5 类 token（口径见文件头"计算口径与公式"）。 */
function extractTokens(
  usage: Record<string, unknown>,
  upstreamUrl: string,
): { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number } {
  const protocol = detectProtocol(upstreamUrl);
  const output = numField(usage.completion_tokens) || numField(usage.output_tokens);

  let input = 0;
  let cacheRead = 0;
  let cacheWrite5m = 0;
  let cacheWrite1h = 0;

  if (protocol === "anthropic") {
    input = numField(usage.input_tokens);
    cacheRead = numField(usage.cache_read_input_tokens);
    const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined;
    const ephemeral5m = numField(cacheCreation?.ephemeral_5m_input_tokens);
    const ephemeral1h = numField(cacheCreation?.ephemeral_1h_input_tokens);
    const totalCacheWrite = numField(usage.cache_creation_input_tokens);
    cacheWrite5m = ephemeral5m;
    cacheWrite1h = ephemeral1h;
    // 无 TTL 明细的余额按默认 5m 计价
    cacheWrite5m += Math.max(0, totalCacheWrite - ephemeral5m - ephemeral1h);
  } else if (protocol === "responses") {
    const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
    const inputTokens = numField(usage.input_tokens);
    cacheRead = numField(usage.cache_read_tokens) || numField(inputDetails?.cached_tokens);
    input = Math.max(0, inputTokens - cacheRead);
    cacheWrite5m = numField(usage.cache_write_tokens) || numField(usage.prompt_cache_write_tokens);
    cacheWrite1h = 0;
  } else {
    const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
    const promptTokens = numField(usage.prompt_tokens);
    cacheRead = numField(usage.cache_read_tokens) || numField(promptDetails?.cached_tokens);
    input = Math.max(0, promptTokens - cacheRead);
    cacheWrite5m = numField(usage.cache_write_tokens) || numField(usage.prompt_cache_write_tokens);
    cacheWrite1h = 0;
  }

  return { input, output, cacheRead, cacheWrite5m, cacheWrite1h };
}

/**
 * 记录一笔命中自定义上游分组的用量。
 *
 * 唯一入口。调用方（目前是 pipeline/stages/credit.ts 的 skipCreditReport 分支
 * 与 pipeline/runners/utility.ts）必须保证：
 *   - 仅对 kind=override（custom 组）的请求调用（E5：避免与计费链路重复计数）
 *   - 不对 auxiliary / headless 请求调用（E6）
 *
 * 本函数永不抛错：统计失败不得影响主链路。
 */
export function recordCustomUpstreamUsage(input: CustomUpstreamUsageInput): void {
  // E1 / E4：无 usage 对象或空对象 → 不计入
  if (!input.usage || Object.keys(input.usage).length === 0) return;

  const tokens = extractTokens(input.usage, input.upstreamUrl ?? "");

  // 折价：价目表 → 时段规则 → 分档（与 computeCreditDelta 同口径）
  let equivalentCredit = 0;
  let unpricedTokens = 0;
  const pricing = getModelPricing(input.pricing, input.modelId ?? null);
  if (pricing) {
    const totalInput = tokens.input + tokens.cacheRead;
    const rulePricing = resolveRulePricingDetail(input.pricing, pricing, input.requestTime);
    const selected = resolveTierPricing(rulePricing.pricing, totalInput);
    equivalentCredit =
      (tokens.input / 1000) * selected.input +
      (tokens.output / 1000) * selected.output +
      (tokens.cacheRead / 1000) * selected.cacheRead +
      (tokens.cacheWrite5m / 1000) * selected.cacheWrite5m +
      (tokens.cacheWrite1h / 1000) * selected.cacheWrite1h;
  } else {
    // E3：未登记价目 → 不折价，但 token 量照记，避免"用了多少"丢失
    unpricedTokens = tokens.input + tokens.output;
  }

  const key = keyOf({
    spaceId: input.spaceId,
    agent: input.agent,
    groupId: input.groupId,
    groupName: input.groupName,
    model: input.modelId ?? "unknown",
    teamId: input.teamId ?? "",
  });

  let acc = store.get(key);
  if (!acc) {
    // 容量保护：超过上限则丢弃最旧的一条（Map 保序）
    if (store.size >= MAX_KEYS) {
      const oldest = store.keys().next();
      if (!oldest.done) store.delete(oldest.value);
    }
    acc = {
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      equivalentCredit: 0,
      unpricedTokens: 0,
      lastAt: "",
    };
    store.set(key, acc);
  }

  acc.requests += 1;
  acc.input += tokens.input;
  acc.output += tokens.output;
  acc.cacheRead += tokens.cacheRead;
  acc.cacheWrite5m += tokens.cacheWrite5m;
  acc.cacheWrite1h += tokens.cacheWrite1h;
  acc.equivalentCredit += equivalentCredit;
  acc.unpricedTokens += unpricedTokens;
  acc.lastAt = (input.requestTime ?? new Date()).toISOString();
}

/** 对外快照（供 HTTP 端点与面板消费）。 */
export interface UpstreamUsageSnapshot {
  /** 口径说明，随数据一起下发，防止消费方误把 equivalentCredit 当账单 */
  note: string;
  /** 是否计入平台计费 —— 恒为 false（见文件头"不纳入"说明） */
  billedToPlatform: false;
  generatedAt: string;
  items: Array<UsageKey & UsageAccum>;
  totals: Omit<UsageAccum, "lastAt">;
}

export function snapshotUpstreamUsage(): UpstreamUsageSnapshot {
  const items: Array<UsageKey & UsageAccum> = [];
  const totals = {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    equivalentCredit: 0,
    unpricedTokens: 0,
  };

  for (const [key, acc] of store) {
    const [spaceId, agent, groupId, groupName, model, teamId] = key.split("|");
    items.push({
      spaceId,
      agent,
      groupId,
      groupName: groupName ?? groupId,
      model,
      teamId: teamId ?? "",
      ...acc,
    });
    totals.requests += acc.requests;
    totals.input += acc.input;
    totals.output += acc.output;
    totals.cacheRead += acc.cacheRead;
    totals.cacheWrite5m += acc.cacheWrite5m;
    totals.cacheWrite1h += acc.cacheWrite1h;
    totals.equivalentCredit += acc.equivalentCredit;
    totals.unpricedTokens += acc.unpricedTokens;
  }

  // 按请求数降序，面板展示更聚焦
  items.sort((a, b) => b.requests - a.requests);

  return {
    note:
      "自定义上游（custom upstream）用量统计。equivalentCredit 是按平台价目表折算的参考值，" +
      "表示这笔流量若走平台官方通道的等价花费；该流量由用户自付，不计入平台账单（billedToPlatform=false）。",
    billedToPlatform: false,
    generatedAt: new Date().toISOString(),
    items,
    totals,
  };
}

/** 清零（仅供运维/测试）。 */
export function resetUpstreamUsage(): void {
  store.clear();
}
