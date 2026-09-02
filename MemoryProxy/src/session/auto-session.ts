/**
 * 会话 ID 自动生成与续接（autoConversationId）。
 *
 * 对于没有自带稳定会话 ID 的客户端（Hermes / OpenClaw / DSH 等），服务端按
 * API key 派生 keyId 生成会话锁，避免不同客户端上报相同 sessionKey 导致碰撞。
 *
 * 生成的 ID 带 HMAC 签名：`auto-<签名>-<uuid>`，签名绑定 keyId + scope(thread) +
 * 首问指纹 + uuid，跨线程/跨窗口/换 key 复用一律拒绝。进程重启或换 key 后旧 ID
 * 无法通过校验，直接按缺失处理重新生成，避免“幽灵会话”错绑身份。
 *
 * 单节点实现：进程内 Map + TTL（默认 30 分钟）+ 容量上限；多节点部署时把状态
 * 换成共享存储，签名密钥通过 TDAI_SESSION_SIGNING_KEY 保持一致。开启
 * `deterministic: true` 后 sid 由 (keyId, scope, 指纹, epoch) 派生，任意实例 /
 * 重启在同一 epoch 内收敛到同一 sid（无共享状态的最优近似）。
 * 显式上报的会话 ID 始终优先，本机制只在缺失时触发（完全向后兼容）。
 */
import {
  randomUUID,
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { recordSession } from "../common/session-stats.js";

export interface AutoConversationIdConfig {
  enabled?: boolean;
  ttlMinutes?: number;
  strategy?: "per-key" | "per-key-msg";
  /**
   * true → sid 由 (keyId, scope, 首问指纹, epoch) 确定性派生，同一逻辑会话在
   * 任意实例 / 重启后收敛到同一 sid（不再依赖进程内 Map 记忆 uuid）。
   * epoch = now / ttlMs：空闲跨桶的会话自然轮换，活跃会话由 Map 续接不受影响。
   * 默认 false = 保留随机 uuid（原行为）。
   */
  deterministic?: boolean;
  /**
   * deterministic 模式的 epoch 桶宽（分钟）。缺省 = ttlMinutes。
   * 钉住一个 ≥ ttlMinutes 的桶宽可让"只调 ttl"不触发全量会话轮换。
   * 必须 ≥ ttlMinutes，否则空闲跨桶未过期时会话会确定性碰撞（校验见 config.ts）。
   */
  deterministicBucketMinutes?: number;
  maxEntries?: number;
  maxWindowsPerKey?: number;
  maxWindowsTotal?: number;
}

interface ActiveSession {
  sid: string;
  lastSeen: number;
  scope: string;
}

interface MsgSession {
  sid: string;
  fingerprint: string;
  scope: string;
  lastSeen: number;
}

const ACTIVE = new Map<string, ActiveSession>();
const ACTIVE_MSG = new Map<string, MsgSession[]>();
const MAX_ENTRIES = 2048;
const MAX_WINDOWS_PER_KEY = 8;
const MAX_WINDOWS_TOTAL = 4096;
const EXPIRED_LEDGER_MAX = 512;

/** 会话结束台账（有界）：记录过期/被 prune 的 sid，供审计与归档桥接。 */
export interface ExpiredSessionEntry {
  sid: string;
  keyId: string;
  scope: string;
  reason: "expired" | "pruned" | "evicted";
  lastSeen: number;
  expiredAt: number;
}

const EXPIRED_LEDGER: ExpiredSessionEntry[] = [];

function recordExpired(entry: ExpiredSessionEntry): void {
  EXPIRED_LEDGER.push(entry);
  if (EXPIRED_LEDGER.length > EXPIRED_LEDGER_MAX) {
    EXPIRED_LEDGER.splice(0, EXPIRED_LEDGER.length - EXPIRED_LEDGER_MAX);
  }
}

/** 最近结束的会话（诊断端点用；不暴露给业务注入路径）。 */
export function recentExpiredSessions(): ExpiredSessionEntry[] {
  return [...EXPIRED_LEDGER];
}

// ── 签名密钥 ──────────────────────────────────────────────────────────────
// 默认每次启动随机生成：重启后旧 auto- 会话 ID 全部失效，从源头杜绝幽灵会话；
// 多实例共享同一密钥（环境变量注入）即可跨实例校验。
const SESSION_SIGNING_KEY =
  process.env.TDAI_SESSION_SIGNING_KEY ?? randomUUID();

const SID_RE =
  /^auto-([0-9a-f]{16})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** 签名绑定 keyId + scope + 首问指纹 + uuid：sid 不能跨线程/跨窗口/跨 key 复用。 */
function signSessionId(
  keyId: string,
  scope: string,
  fp: string,
  uuid: string,
): string {
  return createHmac("sha256", SESSION_SIGNING_KEY)
    .update(`${keyId}\u0000${scope}\u0000${fp}\u0000${uuid}`)
    .digest("hex")
    .slice(0, 16);
}

/** 校验 auto- 会话 ID 是否由本进程（或共享密钥的实例）为同一 (key, scope, fp) 签发。 */
function verifySessionId(
  sid: string,
  keyId: string,
  scope: string,
  fp: string,
): boolean {
  const m = SID_RE.exec(sid);
  if (!m) return false;
  const expect = Buffer.from(signSessionId(keyId, scope, fp, m[2]), "hex");
  const actual = Buffer.from(m[1], "hex");
  return expect.length === actual.length && timingSafeEqual(expect, actual);
}

/**
 * 确定性派生 uuid（deterministic 模式）：同一 (keyId, scope, fp, epoch) 在任意
 * 实例 / 重启后得到同一 sid；epoch = now / ttlMs 使空闲跨桶的会话自然轮换。
 */
function deriveUuid(
  keyId: string,
  scope: string,
  fp: string,
  epoch: number,
): string {
  const h = createHmac("sha256", SESSION_SIGNING_KEY)
    .update(`${keyId}\u0000${scope}\u0000${fp}\u0000epoch:${epoch}`)
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function makeSid(
  keyId: string,
  scope: string,
  fp: string,
  cfg: AutoConversationIdConfig | undefined,
  now: number,
  ttlMs: number,
): string {
  const uuid =
    cfg?.deterministic === true
      ? deriveUuid(
          keyId,
          scope,
          fp,
          Math.floor(now / Math.max(ttlMs, (cfg?.deterministicBucketMinutes ?? 0) * 60_000)),
        )
      : randomUUID();
  return `auto-${signSessionId(keyId, scope, fp, uuid)}-${uuid}`;
}

// ── 可注入时钟（测试用）─────────────────────────────────────────────────
let nowFn: () => number = () => Date.now();

/** 测试专用：替换当前时间源（vitest 里配合 __resetAutoSessionForTests 使用）。 */
export function __setAutoSessionNow(fn: () => number): void {
  nowFn = fn;
}

/** 测试专用：清空进程内会话表，避免用例间状态串扰。 */
export function __resetAutoSessionForTests(): void {
  ACTIVE.clear();
  ACTIVE_MSG.clear();
  EXPIRED_LEDGER.length = 0;
}

/** 从首条用户消息文本生成稳定的会话指纹（sha256 前 16 hex）。 */
export function messageFingerprint(text: string): string {
  return createHash("sha256").update(text ?? "").digest("hex").slice(0, 16);
}

function windowTotal(): number {
  let total = 0;
  for (const list of ACTIVE_MSG.values()) total += list.length;
  return total;
}

/** 当前活跃会话与窗口的数量（供诊断端点和指标使用，不暴露具体 ID）。 */
export function autoSessionSizes(): { activeKeys: number; windows: number } {
  return { activeKeys: ACTIVE.size, windows: windowTotal() };
}

/**
 * 清理所有 key 下已过期的窗口，返回清理数量。
 * 供宿主定时调用，避免低流量时过期条目长期滞留内存。
 */
export function pruneExpiredSessions(ttlMinutes: number): number {
  const ttlMs = ttlMinutes * 60_000;
  const now = nowFn();
  let removed = 0;
  for (const [k, v] of ACTIVE) {
    if (now - v.lastSeen > ttlMs) {
      ACTIVE.delete(k);
      const sep = k.indexOf("\u0000");
      recordExpired({
        sid: v.sid,
        keyId: sep >= 0 ? k.slice(0, sep) : k,
        scope: sep >= 0 ? k.slice(sep + 1) : "",
        reason: "pruned",
        lastSeen: v.lastSeen,
        expiredAt: now,
      });
      removed += 1;
    }
  }
  for (const [k, list] of ACTIVE_MSG) {
    const dead = list.filter((s) => now - s.lastSeen >= ttlMs);
    const alive = list.filter((s) => now - s.lastSeen < ttlMs);
    for (const s of dead) {
      recordExpired({
        sid: s.sid,
        keyId: k,
        scope: s.scope,
        reason: "pruned",
        lastSeen: s.lastSeen,
        expiredAt: now,
      });
    }
    removed += dead.length;
    if (alive.length > 0) ACTIVE_MSG.set(k, alive);
    else ACTIVE_MSG.delete(k);
  }
  if (removed > 0) recordSession("expired", removed);
  return removed;
}

/** 全局窗口超限时按最近使用时间淘汰最旧的，返回淘汰数量。 */
function evictWindows(now: number, maxWindowsTotal: number): number {
  let removed = 0;
  const floor = Math.floor(maxWindowsTotal * 0.8);
  const all: Array<{ key: string; idx: number; lastSeen: number }> = [];
  for (const [key, list] of ACTIVE_MSG) {
    list.forEach((s, idx) => all.push({ key, idx, lastSeen: s.lastSeen }));
  }
  all.sort((a, b) => a.lastSeen - b.lastSeen);
  for (const item of all) {
    if (windowTotal() <= floor) break;
    const list = ACTIVE_MSG.get(item.key);
    if (!list) continue;
    const removedWindow = list.findIndex((s) => s.lastSeen === item.lastSeen);
    if (removedWindow >= 0) {
      const victim = list[removedWindow];
      list.splice(removedWindow, 1);
      recordExpired({
        sid: victim.sid,
        keyId: item.key,
        scope: victim.scope,
        reason: "evicted",
        lastSeen: victim.lastSeen,
        expiredAt: now,
      });
      removed += 1;
      if (list.length === 0) ACTIVE_MSG.delete(item.key);
      else ACTIVE_MSG.set(item.key, list);
    }
  }
  return removed;
}

/**
 * 解析会话 ID：显式 ID 优先；缺失且开启 auto 时按 keyId 生成/续接。
 * scope 用于同一 key 下按线程/任务维度隔离（不传时保持单会话行为）。
 */
export function resolveOrCreateSessionId(
  existing: string | null,
  keyId: string,
  cfg: AutoConversationIdConfig | undefined,
  msgFingerprint?: string,
  scope = "",
  meta?: { agentSource?: string; spaceId?: string },
): { sessionId: string; autoGenerated: boolean; reused?: boolean; rejected?: boolean } {
  const record = (
    kind: Parameters<typeof recordSession>[0],
    n = 1,
  ): void => recordSession(kind, n, meta);
  if (existing && existing.length > 0) {
    if (existing.startsWith("auto-")) {
      // 签名绑定 (keyId, scope, fp)：跨线程/跨窗口复用、旧 key 或伪造 ID
      // 一律拒绝。auto 未启用时置 rejected，调用方不得回退到 raw（防幽灵会话）。
      const fp = msgFingerprint ?? "";
      if (!verifySessionId(existing, keyId, scope, fp)) {
        // 拆计数：带 scope/指纹（绑定上下文）被拒 → scopeRejected；
        // 默认上下文（无 scope/fp）被拒 → ghostRejected（签名/换 key/伪造）。
        if (scope || fp) record("scopeRejected");
        else record("ghostRejected");
        if (!cfg?.enabled) {
          return { sessionId: "", autoGenerated: false, rejected: true };
        }
      } else {
        return { sessionId: existing, autoGenerated: false };
      }
    } else {
      return { sessionId: existing, autoGenerated: false };
    }
  }
  if (!cfg?.enabled) {
    return { sessionId: "", autoGenerated: false };
  }
  const ttlMs = (cfg.ttlMinutes ?? 30) * 60_000;
  const now = nowFn();
  const strategy = cfg.strategy ?? "per-key";

  // per-key-msg：同一 key 下按"首条用户消息指纹 + scope"区分多个窗口。
  if (strategy === "per-key-msg" && msgFingerprint) {
    const maxWindowsPerKey = cfg.maxWindowsPerKey ?? MAX_WINDOWS_PER_KEY;
    const maxWindowsTotal = cfg.maxWindowsTotal ?? MAX_WINDOWS_TOTAL;
    const list = ACTIVE_MSG.get(keyId);
    if (list) {
      const hit = list.find(
        (s) =>
          s.fingerprint === msgFingerprint &&
          s.scope === scope &&
          now - s.lastSeen < ttlMs,
      );
      if (hit) {
        hit.lastSeen = now;
        record("resumed");
        return { sessionId: hit.sid, autoGenerated: true, reused: true };
      }
    }
    const sid = makeSid(keyId, scope, msgFingerprint, cfg, now, ttlMs);
    const entry: MsgSession = { sid, fingerprint: msgFingerprint, scope, lastSeen: now };
    const alive = list ? list.filter((s) => now - s.lastSeen < ttlMs) : [];
    const dead = list ? list.filter((s) => now - s.lastSeen >= ttlMs) : [];
    for (const s of dead) {
      recordExpired({
        sid: s.sid,
        keyId,
        scope: s.scope,
        reason: "expired",
        lastSeen: s.lastSeen,
        expiredAt: now,
      });
    }
    if (dead.length > 0) {
      record("expired", dead.length);
    }
    const next = [entry, ...alive];
    const trimmed = next.slice(0, maxWindowsPerKey);
    if (next.length > trimmed.length) {
      record("windowEvicted", next.length - trimmed.length);
      for (const v of next.slice(maxWindowsPerKey)) {
        recordExpired({
          sid: v.sid,
          keyId,
          scope: v.scope,
          reason: "evicted",
          lastSeen: v.lastSeen,
          expiredAt: now,
        });
      }
    }
    ACTIVE_MSG.set(keyId, trimmed);
    if (windowTotal() > maxWindowsTotal) {
      const evicted = evictWindows(now, maxWindowsTotal);
      if (evicted > 0) record("capEvicted", evicted);
    }
    record("created");
    return { sessionId: sid, autoGenerated: true, reused: false };
  }

  // per-key：默认一个 key 一个活跃会话；带 scope 时按 (key, scope) 隔离，
  // 适合同一 key 下并行线程/任务需要互不串台的情况。
  const maxEntries = cfg.maxEntries ?? MAX_ENTRIES;
  const key = scope ? `${keyId}\u0000${scope}` : keyId;
  const hit = ACTIVE.get(key);
  if (hit && now - hit.lastSeen < ttlMs) {
    hit.lastSeen = now;
    record("resumed");
    return { sessionId: hit.sid, autoGenerated: true, reused: true };
  }
  if (hit) {
    record("expired");
    recordExpired({
      sid: hit.sid,
      keyId,
      scope: hit.scope,
      reason: "expired",
      lastSeen: hit.lastSeen,
      expiredAt: now,
    });
  }
  const sid = makeSid(keyId, scope, "", cfg, now, ttlMs);
  ACTIVE.set(key, { sid, lastSeen: now, scope });
  if (ACTIVE.size > maxEntries) {
    // 先清过期；仍超限则按最近使用时间淘汰最旧的，避免长期运行内存无界增长
    let expired = 0;
    for (const [k, v] of ACTIVE) {
      if (now - v.lastSeen > ttlMs) {
        ACTIVE.delete(k);
        expired += 1;
      }
    }
    if (expired > 0) record("expired", expired);
    if (ACTIVE.size > maxEntries) {
      const floor = Math.floor(maxEntries * 0.8);
      const byOldest = [...ACTIVE.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      let removed = 0;
      while (ACTIVE.size > floor && removed < byOldest.length) {
        const [k, v] = byOldest[removed];
        ACTIVE.delete(k);
        recordExpired({
          sid: v.sid,
          keyId,
          scope: v.scope,
          reason: "evicted",
          lastSeen: v.lastSeen,
          expiredAt: now,
        });
        removed += 1;
      }
      if (removed > 0) record("capEvicted", removed);
    }
  }
  record("created");
  return { sessionId: sid, autoGenerated: true, reused: false };
}
