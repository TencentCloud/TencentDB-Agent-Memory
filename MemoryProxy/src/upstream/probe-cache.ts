/**
 * 探测结果缓存。
 *
 * 把"每个 agent 的上游能力"落成一个小 JSON：重启时可直接复用，不必再向上游
 * 发一轮探测请求；定期重探会覆盖它。缓存键包含 url 与探测模型名，配置改了自然失效。
 *
 * 容错原则：文件缺失、内容损坏、版本不符，一律当作"没有缓存"，退回真实探测，
 * 绝不让缓存本身成为启动失败的原因。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProxyConfig } from "../types.js";
import type { UpstreamCapabilities } from "./capability-probe.js";

export interface ProbeCacheEntry {
  url: string;
  probeModel: string;
  caps: UpstreamCapabilities;
  updatedAt: number;
}

export type ProbeCacheEntries = Record<string, ProbeCacheEntry>;

const CACHE_VERSION = 1;

/** 读取缓存；任何异常都返回空表。 */
export function readProbeCache(config: ProxyConfig): ProbeCacheEntries {
  const file = config.upstream.autoDetect?.cacheFile;
  if (!file) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      version?: number;
      entries?: ProbeCacheEntries;
    };
    if (raw?.version !== CACHE_VERSION || !raw.entries || typeof raw.entries !== "object") {
      return {};
    }
    return raw.entries;
  } catch {
    return {};
  }
}

/** 写入缓存；失败只记日志（调用方决定），不影响本轮探测结果。 */
export function writeProbeCache(config: ProxyConfig, entries: ProbeCacheEntries): boolean {
  const file = config.upstream.autoDetect?.cacheFile;
  if (!file) return false;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify(
        { version: CACHE_VERSION, updatedAt: new Date().toISOString(), entries },
        null,
        2,
      )}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 取某个 agent 的可用缓存：url 与探测模型名必须一致，且未超过 TTL。
 * ttlMinutes 为 0 表示不因过期而重探（仅由定期重探刷新）。
 */
export function pickCachedCaps(
  entries: ProbeCacheEntries,
  agent: string,
  url: string,
  probeModel: string,
  ttlMinutes: number,
  now = Date.now(),
): UpstreamCapabilities | null {
  const hit = entries[agent];
  if (!hit) return null;
  if (hit.url !== url || hit.probeModel !== probeModel) return null;
  if (ttlMinutes > 0 && now - hit.updatedAt > ttlMinutes * 60_000) return null;
  const caps = hit.caps;
  if (!caps || typeof caps.chat !== "boolean" || typeof caps.responses !== "boolean"
    || typeof caps.anthropic !== "boolean") {
    return null;
  }
  return { chat: caps.chat, responses: caps.responses, anthropic: caps.anthropic };
}
