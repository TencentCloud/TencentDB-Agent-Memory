/**
 * 上游协议能力自动探测（题目六「上游协议能力识别」落地）。
 *
 * 启动时对每个 agent 的最终上游 URL 探测三种协议端点是否存在
 * （OpenAI Chat / OpenAI Responses / Anthropic Messages），并按
 * 「客户端原生协议优先，否则自动转换」生成 per-agent 转换标志。
 * 显式配置的转换标志始终优先于探测结果（向后兼容）。
 *
 * 探测用最小请求（max_tokens=1），端点存在性判定：
 *   200 / 400 / 401 / 403 / 422 / 429 → 端点存在（支持）
 *   404 / 405                       → 端点不存在（不支持）
 *   网络错误                        → 不支持（降级直连）
 *
 * ⚠️ 404 的固有歧义与规避方式：部分厂商对「模型名不存在」也返回 404
 * （OpenAI `model_not_found`、Azure `DeploymentNotFound`），此时探测会把一个真实
 * 可用的端点判成「不支持」。因此**不要依赖错误体去猜**，而是把探测模型配成真实
 * 模型名：`upstream.autoDetect.probeModel: <真实模型名>`。未配置时仍用占位符
 * `ping`，并在打到 404 时打一条 warn 提示该歧义。
 *
 * 设计口径（"按协议判断，不按客户端名字判断"）：
 *   - **客户端说哪种协议**：由 `agent-adapters/*.ts` 的 `nativeProtocols` 声明，
 *     本模块不再维护第二份客户端名单；
 *   - **上游支持哪些协议**：是上游地址的性质，一轮探测里同一 `url + 凭据 + 模型`
 *     只探一次，多个客户端共用同一上游时共享结论（文件缓存同样按 url 命中）；
 *   - **怎么转**：只由 (客户端协议, 上游能力) 决定，见 `FALLBACK_ORDER` /
 *     `TRANSFORM_FLAGS`；未实现的组合一律判为"无路可走"并告警，不静默直连。
 */
import { createHash } from "node:crypto";
import type { AgentUpstreamEntry, ProxyConfig } from "../types.js";
import { log } from "../report/log.js";
import { KNOWN_AGENT_KINDS, resolveAgentAdapter } from "../agent-adapters/index.js";
import type { NativeProtocol } from "../agent-adapters/types.js";
import {
  pickCachedCapsByUrl,
  readProbeCache,
  writeProbeCache,
  type ProbeCacheEntries,
} from "./probe-cache.js";
import {
  recordProbeCacheHit,
  recordProbeCacheMiss,
  recordProbeChange,
  recordProbeFailure,
  recordProbeRun,
} from "./probe-stats.js";

export interface UpstreamCapabilities {
  chat: boolean;
  responses: boolean;
  anthropic: boolean;
}

export interface AutoDetectConfig {
  enabled?: boolean;
  timeoutMs?: number;
  /**
   * 探测请求里使用的模型名。默认占位符 `ping`；建议配成该上游真实模型名，
   * 以避开「未知模型 → 404」被误判成「端点不存在」。
   */
  probeModel?: string;
  /**
   * 探测结果缓存文件（JSON）。配置后：启动时命中未过期的缓存就直接复用，
   * 不再向上游发探测请求；每轮探测结束都会刷新它。留空则只在进程内保留。
   */
  cacheFile?: string;
  /** 缓存有效期（分钟）。0 表示不因过期重探，只由定期重探刷新。 */
  cacheTtlMinutes?: number;
  /** 定期重探间隔（分钟）。0 或缺省表示只在启动时探测一次。 */
  reprobeIntervalMinutes?: number;
}

/**
 * 按协议族构造鉴权头（与 4 个 handler 的转发规则保持一致）：
 *   - Anthropic Messages：`x-api-key` + `anthropic-version`
 *   - OpenAI Chat / Responses：`Authorization: Bearer`
 * 之前这里一律发 Bearer，真实 Anthropic 上游会 401（虽然仍会被判成"端点存在"，
 * 但探测结果与真实调用口径不一致，排查时容易误导）。
 */
function authHeaders(
  kind: "chat" | "responses" | "anthropic",
  apiKey: string,
): Record<string, string> {
  if (kind === "anthropic") {
    return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  }
  return { authorization: `Bearer ${apiKey}` };
}

async function probeEndpoint(
  url: string,
  apiKey: string,
  kind: "chat" | "responses" | "anthropic",
  timeoutMs: number,
  probeModel: string,
): Promise<boolean> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...authHeaders(kind, apiKey),
  };
  let body: string;
  if (kind === "chat") {
    body = JSON.stringify({
      model: probeModel,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    });
  } else if (kind === "responses") {
    body = JSON.stringify({ model: probeModel, input: "ping", max_output_tokens: 1 });
  } else {
    body = JSON.stringify({
      model: probeModel,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return true;
    if (res.status === 404 || res.status === 405) {
      // 见文件头：404 可能是"路由不存在"，也可能是"模型名不存在"。这里保守按
      // 不支持处理，并提示用真实模型名重探。
      log.warn("upstream.probe.ambiguous_404", {
        url,
        kind,
        status: res.status,
        probeModel,
        hint: "404 既可能是端点不存在，也可能是该模型名不存在；若上游确实有该端点，请把 upstream.autoDetect.probeModel 配成真实模型名后重试",
      });
      return false;
    }
    return [400, 401, 403, 422, 429].includes(res.status);
  } catch {
    return false;
  }
}

/** 已知的“完整端点”后缀：配置里可能直接写完整 URL（如 …/chat/completions）。 */
const KNOWN_ENDPOINT_SUFFIXES = [
  "/chat/completions",
  "/v1/messages",
  "/messages",
  "/responses",
] as const;

/** 若 URL 已是完整端点，剥掉端点后缀得到可用于探测兄弟端点的根。 */
function stripKnownEndpoint(url: string): string {
  for (const suffix of KNOWN_ENDPOINT_SUFFIXES) {
    if (url.endsWith(suffix)) return url.slice(0, -suffix.length);
  }
  return url;
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** 对一组候选 URL 并行探测，任一命中即认为该协议存在。 */
async function probeAny(
  urls: string[],
  apiKey: string,
  kind: "chat" | "responses" | "anthropic",
  timeoutMs: number,
  probeModel: string,
): Promise<boolean> {
  const results = await Promise.all(
    urls.map((url) => probeEndpoint(url, apiKey, kind, timeoutMs, probeModel)),
  );
  return results.some(Boolean);
}

/**
 * 探测单个上游 URL 的三协议能力（并行、失败降级为 false）。
 * 兼容两种配置形态：
 *  - 协议无关根地址：https://host/v1 → 拼 /chat/completions、/responses、/messages；
 *  - 完整端点：https://host/v2/chat/completions → 先剥后缀得到根，再对根探测兄弟
 *    端点（同时保证完整端点自身仍按对应协议探测一次），避免拼出
 *    …/chat/completions/chat/completions 这类无效路径导致探测静默全失败。
 */
export async function probeCapabilities(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 3000,
  probeModel = "ping",
): Promise<UpstreamCapabilities> {
  const base = (baseUrl.split("?")[0] ?? baseUrl).replace(/\/+$/, "");
  const root = stripKnownEndpoint(base);
  // Anthropic 端点有两种常见写法：带版本段（…/v1/messages）与不带（…/messages）。
  // root 若已经以 /vN 结尾，就不要再拼一次版本段——否则会产生
  // `…/v1/v1/messages` 这种无效候选，白跑一次请求、并多出一条 404 歧义告警
  // （真机实测：DeepSeek 上游每次都多打一条 ambiguous_404）。
  const versionedRoot = /\/v\d+$/.test(root) ? root : `${root}/v1`;
  const [chat, responses, anthropic] = await Promise.all([
    probeAny(unique([`${root}/chat/completions`]), apiKey, "chat", timeoutMs, probeModel),
    probeAny(unique([`${root}/responses`]), apiKey, "responses", timeoutMs, probeModel),
    probeAny(
      unique([`${versionedRoot}/messages`, `${root}/messages`]),
      apiKey,
      "anthropic",
      timeoutMs,
      probeModel,
    ),
  ]);
  return { chat, responses, anthropic };
}

/** 全部协议维度（探测与测试共用）。 */
export const ALL_PROTOCOLS: readonly NativeProtocol[] = ["chat", "responses", "anthropic"];

/**
 * 客户端**原生协议**（它自己对上游说哪种协议）。
 *
 * ⚠️ 这里刻意不再维护客户端名单：唯一真源是各 adapter 的 `nativeProtocols`
 * （见 `agent-adapters/types.ts`）。历史上本模块有一份只列了 4 个客户端的
 * `NATIVE_PROTOCOLS`，新增客户端（dsh / opencode / pi …）漏在里面时既不会写入
 * 转换开关、也不会触发"无路可走"告警，表现为静默直连 + 上游 400。
 *
 * 未声明的客户端返回空数组 ⇒ 不产生任何开关（保持现状不变），但会在启动期
 * 打 `upstream.probe.undeclared_protocol` 提示补声明。
 */
export function nativeProtocolsOf(agent: string): readonly NativeProtocol[] {
  return resolveAgentAdapter(agent).nativeProtocols ?? [];
}

export type TransformFlag =
  | "chatCompletions"
  | "chatToAnthropic"
  | "anthropicToChat"
  | "anthropicToResponses"
  | "responsesToAnthropic";

/**
 * 客户端协议 → 上游没有该协议时的**目标协议优先级**。
 *
 * 这是「按协议判断」的唯一落点：新增客户端只要在 adapter 里声明 nativeProtocols，
 * 就自动获得这套选路，不需要改本文件。
 *   - chat：只能转 Anthropic（chat→Responses 未实现）
 *   - anthropic：优先 Chat，其次 Responses
 *   - responses：优先 Anthropic，其次 Chat
 */
const FALLBACK_ORDER: Record<NativeProtocol, readonly NativeProtocol[]> = {
  chat: ["anthropic"],
  anthropic: ["chat", "responses"],
  responses: ["anthropic", "chat"],
};

/** 已实现的转换方向。缺的组合 = 未实现，必须显式告警而不是静默穿透。 */
const TRANSFORM_FLAGS: Partial<Record<string, TransformFlag>> = {
  "chat->anthropic": "chatToAnthropic",
  "anthropic->chat": "anthropicToChat",
  "anthropic->responses": "anthropicToResponses",
  "responses->anthropic": "responsesToAnthropic",
  "responses->chat": "chatCompletions",
};

export type UpstreamRoute =
  | { kind: "direct" }
  | { kind: "convert"; flag: TransformFlag }
  | { kind: "unimplemented" };

/** 单一决策函数：(客户端协议, 上游能力) → 直连 / 转哪个方向 / 无路可走。 */
export function resolveRoute(
  client: NativeProtocol,
  caps: UpstreamCapabilities,
): UpstreamRoute {
  if (caps[client]) return { kind: "direct" };
  for (const target of FALLBACK_ORDER[client]) {
    if (!caps[target]) continue;
    const flag = TRANSFORM_FLAGS[`${client}->${target}`];
    if (flag) return { kind: "convert", flag };
  }
  return { kind: "unimplemented" };
}

/** 显式配置过的转换开关（true/false 都算）：配置了就不让 autoDetect 覆盖（用户意图优先）。 */
const EXPLICIT_FLAGS = [
  "chatCompletions",
  "chatToAnthropic",
  "anthropicToChat",
  "anthropicToResponses",
  "responsesToAnthropic",
] as const;

/**
 * 上一次探测得到的能力：用于能力变更检测、"三端点全不通"时保留旧结论，
 * 以及**请求期决策**（`conversionEnabled` 按 url+凭据+模型 查它）。
 *
 * 注意（2026-09-12 起）：探测**不再把结论写回 `config.upstream.agents`**。
 * 早期实现把探测结果写成 per-agent 转换开关，于是"配置对象"同时承担了
 * 用户意图与运行时状态两件事，重探还要额外做一遍撤销。现在探测只维护这份
 * 运行时能力表，决策在请求期由 (请求协议, 上游能力) 现算，配置保持只读。
 */
const LAST_CAPS = new Map<string, UpstreamCapabilities>();

/** 单个客户端的协议 × 上游能力 → 转换标志（原生协议优先，direct 不设标志）。 */
export function resolveAgentModesFor(
  agent: string,
  caps: UpstreamCapabilities,
): Partial<AgentUpstreamEntry> {
  const out: Partial<AgentUpstreamEntry> = {};
  for (const client of nativeProtocolsOf(agent)) {
    const route = resolveRoute(client, caps);
    if (route.kind === "convert") out[route.flag] = true;
  }
  return out;
}

/** 该 agent 的上游最近一次探测到的能力（按 `url + 凭据 + 探测模型` 查），没探过返回 null。 */
export function probedCapsFor(
  config: ProxyConfig,
  entry: unknown,
): UpstreamCapabilities | null {
  const e = (entry ?? {}) as { url?: unknown; apiKey?: unknown };
  const url = typeof e.url === "string" && e.url.length > 0 ? e.url : config.upstream.url;
  const apiKey =
    typeof e.apiKey === "string" && e.apiKey.length > 0 ? e.apiKey : config.upstream.apiKey;
  const probeModel = config.upstream.autoDetect?.probeModel ?? "ping";
  return LAST_CAPS.get(probeGroupKey(url, probeModel, apiKey)) ?? null;
}

/**
 * **请求期**决策入口：这个请求要不要启用 `flag` 对应的转换方向。
 *
 * 决策输入只有三样，与"客户端叫什么名字"无关：
 *   ① `client` —— 请求所属协议（由路由/ handler 决定，见 server.ts 的端点绑定）；
 *   ② 该 agent 上游探测到的能力（`probedCapsFor`，运行时表，不写配置）；
 *   ③ 用户的**显式覆盖**：`upstream.agents[agent]` 里手写的转换开关。
 *
 * 判定顺序（与改造前的语义逐条对齐）：
 *   1. 显式写了 `flag: true/false` → 直接照办（显式覆盖优先，false 表示明确禁用）；
 *   2. 该 agent 显式配过**任一**转换开关 → 完全按配置走，不做自动决策；
 *   3. 都没配 → 用 ② 的能力表现算：`resolveRoute(client, caps)` 命中这个 flag 才算启用；
 *   4. 能力表为空（autoDetect 未开、或这台上游没探过）→ false，即保持"不转换"的历史行为。
 */
export function conversionEnabled(
  config: ProxyConfig,
  entry: unknown,
  client: NativeProtocol,
  flag: TransformFlag,
): boolean {
  const flags = (entry ?? {}) as Record<string, unknown>;
  if (flags[flag] === true) return true;
  if (flags[flag] === false) return false;
  if (EXPLICIT_FLAGS.some((f) => flags[f] !== undefined)) return false;
  const caps = probedCapsFor(config, entry);
  if (!caps) return false;
  const route = resolveRoute(client, caps);
  return route.kind === "convert" && route.flag === flag;
}

/** 兼容旧测试/调用方：按三个内置 agent 返回模式表。 */
export function resolveAgentModes(
  caps: UpstreamCapabilities,
): Record<string, Partial<AgentUpstreamEntry>> {
  return {
    workbuddy: resolveAgentModesFor("workbuddy", caps),
    "claude-code": resolveAgentModesFor("claude-code", caps),
    codex: resolveAgentModesFor("codex", caps),
  };
}

/**
 * 该客户端的**原生协议**里，哪些在上游既没有原生端点、也没有已实现的转换方向。
 * 纯函数，供启动期告警与单测使用；返回空数组表示都能走通。
 *
 * 判据与 resolveAgentModesFor 同源（同一张 3×3 表），因此不会出现"既不写开关、
 * 也不告警"的中间态。注意 chat 原生客户端目前**没有** chat→Responses 的实现，
 * 所以 Responses-only 上游会让它彻底无路可走 —— 这种情况必须在启动期告警，
 * 而不是等请求打到上游、拿一个 400 才发现。
 */
export function unroutableNativeProtocols(
  agent: string,
  caps: UpstreamCapabilities,
): string[] {
  return nativeProtocolsOf(agent).filter((p) => resolveRoute(p, caps).kind === "unimplemented");
}

/**
 * 待探测集合 = 所有**声明了原生协议**的已知客户端 ∪ 配置里出现过的 agent，
 * 去掉已显式配置转换开关的项（显式配置优先，也避免多余探测请求）。
 *
 * 从客户端注册表派生，而不是硬编码几个名字：新增客户端只要在 adapter 里声明
 * nativeProtocols 就自动进入探测范围。多个客户端共用同一上游时，真正的探测请求
 * 由 applyAutoDetect 按 `url + 凭据 + 模型` 去重，客户端数量增长不放大探测成本。
 *
 * 注意"显式"的口径：只认**用户写在配置里**的开关。探测自 2026-09-12 起不再回写
 * 配置，所以这里不需要再排除"上一轮探测写进去的项"。
 */
export function agentsToAutoDetect(config: ProxyConfig): string[] {
  const agents = new Set<string>();
  for (const kind of KNOWN_AGENT_KINDS) {
    if (nativeProtocolsOf(kind).length > 0) agents.add(kind);
  }
  for (const name of Object.keys(config.upstream.agents ?? {})) agents.add(name);
  return [...agents].filter((agent) => {
    const entry = config.upstream.agents?.[agent];
    if (!entry) return true;
    return !EXPLICIT_FLAGS.some((f) => entry[f as keyof AgentUpstreamEntry] !== undefined);
  });
}

export interface ApplyAutoDetectOpts {
  /** false 表示忽略缓存、强制真实探测（定期重探使用）。默认 true。 */
  useCache?: boolean;
}

function capsChanged(a: UpstreamCapabilities, b: UpstreamCapabilities): boolean {
  return a.chat !== b.chat || a.responses !== b.responses || a.anthropic !== b.anthropic;
}

/**
 * 上游探测的分组键：`url + 模型名 + 凭据指纹`。
 * 凭据参与分组，避免"同一 url、不同 key"的两个客户端共用一份可能受 401 影响
 * 的结论；指纹只用于分组，不落日志。
 */
function probeGroupKey(url: string, probeModel: string, apiKey: string): string {
  const keyFp = apiKey ? createHash("sha256").update(apiKey).digest("hex").slice(0, 8) : "";
  return `${url}\u0000${probeModel}\u0000${keyFp}`;
}

/**
 * 探测并应用上游能力（显式配置优先）。
 *
 * ① 归组：按 `url + 模型名 + 凭据指纹` 把客户端分组——探测结论是**上游**的性质，
 *    同一上游被多个客户端共用时只探一次；
 * ② 每个唯一上游探一次（或命中缓存），并处理"三端点全不通时保留上一次结论"
 *    与"能力变更告警 / 计数"；
 * ③ 逐个客户端撤销上一轮写入的开关、按 (客户端协议, 上游能力) 重算开关、打日志
 *    与"无路可走"告警；未声明协议的客户端在这里提示补声明。
 *
 * 与首版相比多做了四件事：复用未过期的缓存结果；应用新结果前先撤销上一轮
 * 由探测写入的开关（能力回退时旧开关不会残留）；三端点全不通时保留上一次结论；
 * 能力发生变化时打告警并计数。
 */
export async function applyAutoDetect(
  config: ProxyConfig,
  opts: ApplyAutoDetectOpts = {},
): Promise<void> {
  const useCache = opts.useCache !== false;
  const cfg = config.upstream.autoDetect;
  const timeoutMs = cfg?.timeoutMs ?? 3000;
  const probeModel = cfg?.probeModel ?? "ping";
  const ttlMinutes = cfg?.cacheTtlMinutes ?? 0;
  const agents = (config.upstream.agents ??= {});
  const cacheEntries: ProbeCacheEntries = readProbeCache(config);

  // ① 按上游归组。
  const groups = new Map<string, { url: string; apiKey: string; agents: string[] }>();
  for (const agent of agentsToAutoDetect(config)) {
    const entry = agents[agent] ?? {};
    const url = entry.url ?? config.upstream.url;
    const apiKey = entry.apiKey ?? config.upstream.apiKey;
    const groupKey = probeGroupKey(url, probeModel, apiKey);
    const group = groups.get(groupKey) ?? { url, apiKey, agents: [] };
    group.agents.push(agent);
    groups.set(groupKey, group);
  }

  // ② 每个唯一上游探一次。
  const capsByGroup = new Map<string, { caps: UpstreamCapabilities; fromCache: boolean }>();
  for (const [groupKey, group] of groups) {
    const fileCached = useCache
      ? pickCachedCapsByUrl(cacheEntries, group.url, probeModel, ttlMinutes)
      : null;
    let caps: UpstreamCapabilities;
    let fromCache = false;
    if (fileCached) {
      caps = fileCached;
      fromCache = true;
      recordProbeCacheHit();
    } else {
      recordProbeCacheMiss();
      caps = await probeCapabilities(group.url, group.apiKey, timeoutMs, probeModel);
      recordProbeRun();
    }

    const previous = LAST_CAPS.get(groupKey);
    const nothingReachable = !caps.chat && !caps.responses && !caps.anthropic;
    if (nothingReachable && !fromCache && previous) {
      // 三个端点都没探通，更像是上游临时不可用或凭据失效，而不是"三者都不支持"。
      // 保留上一次结论，等下一轮重探或人工介入，避免把可用配置临时改坏。
      recordProbeFailure();
      log.warn("upstream.probe.all_failed", {
        url: group.url,
        agents: group.agents.join(","),
        probeModel,
        hint: "三协议端点均未探通，已保留上一次探测结果；请检查上游地址、凭据与 probeModel",
      });
      caps = previous;
    }

    if (previous && capsChanged(previous, caps)) {
      for (const agent of group.agents) recordProbeChange(agent);
      log.warn("upstream.probe.changed", {
        url: group.url,
        agents: group.agents.join(","),
        before: previous,
        after: caps,
        hint: "上游协议能力发生变化，已按各客户端原生协议重算转换开关",
      });
    }
    LAST_CAPS.set(groupKey, caps);
    capsByGroup.set(groupKey, { caps, fromCache });
    const now = Date.now();
    for (const agent of group.agents) {
      cacheEntries[agent] = { url: group.url, probeModel, caps, updatedAt: now };
    }
  }

  // ③ 逐个客户端"算而不写"：按 (客户端协议, 上游能力) 得出本轮本该启用的方向，
  //    只用于日志；配置对象保持只读，真正的判定发生在请求期（conversionEnabled）。
  for (const [groupKey, group] of groups) {
    const { caps, fromCache } = capsByGroup.get(groupKey) as {
      caps: UpstreamCapabilities;
      fromCache: boolean;
    };
    for (const agent of group.agents) {
      if (nativeProtocolsOf(agent).length === 0) {
        // 没声明协议的客户端不会产生任何开关：明确说出来，别让它看起来"探测过了"。
        log.warn("upstream.probe.undeclared_protocol", {
          agent,
          url: group.url,
          hint: "该客户端未声明 nativeProtocols（见 src/agent-adapters/*.ts），探测结果不会产生任何转换开关；请补声明，或显式配置 upstream.agents[agent] 的转换开关",
        });
      }

      // 本轮该启用的方向（只算不写）。显式配置过的 agent 不在探测集合里，
      // 所以这里算出来的就是"自动决策结果"。
      const wouldApply = Object.keys(resolveAgentModesFor(agent, caps));

      log.info("upstream.probe", {
        agent,
        url: group.url,
        fromCache,
        chat: caps.chat,
        responses: caps.responses,
        anthropic: caps.anthropic,
        // 语义变更（2026-09-12）：这是"请求期会按协议启用的方向"，不再写进配置。
        wouldApply: wouldApply.join(","),
      });
      const unroutable = unroutableNativeProtocols(agent, caps);
      if (unroutable.length > 0) {
        log.warn("upstream.probe.unroutable", {
          agent,
          url: group.url,
          native: unroutable.join(","),
          chat: caps.chat,
          responses: caps.responses,
          anthropic: caps.anthropic,
          hint: "该客户端的原生协议在上游没有可用端点，且没有已实现的转换方向；请求会直连上游并大概率失败。请显式配置 upstream.agents[agent] 的转换开关，或修正 upstream.url / probeModel",
        });
      }
    }
  }

  writeProbeCache(config, cacheEntries);
}

export interface AutoDetectLoop {
  stop(): void;
}

/**
 * 启动定期重探：仅在 `enabled=true` 且 `reprobeIntervalMinutes > 0` 时生效。
 * 每轮强制真实探测（不走缓存），因此能反映上游在运行期发生的能力变化；
 * 上一轮未结束时跳过本轮，避免请求叠加。
 */
export function startAutoDetectLoop(config: ProxyConfig): AutoDetectLoop | null {
  const cfg = config.upstream.autoDetect;
  if (!cfg?.enabled) return null;
  const minutes = cfg.reprobeIntervalMinutes ?? 0;
  if (!(minutes > 0)) return null;

  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void applyAutoDetect(config, { useCache: false })
      .catch((err: unknown) => log.warn("upstream.probe.failed", { error: String(err) }))
      .finally(() => {
        running = false;
      });
  }, minutes * 60_000);
  if (typeof timer.unref === "function") timer.unref();
  log.info("upstream.probe.schedule", { everyMinutes: minutes });
  return { stop: () => clearInterval(timer) };
}

/** 测试用：清空进程内的"探测写入的开关"与"上一次能力"记录。 */
export function __resetAutoDetectState(): void {
  LAST_CAPS.clear();
}
