/**
 * SkillAgentTaskQueue — agent 级调度信号 + `_tasks.json` 短锁保护。
 *
 * 对应设计文档 §5、§9。
 *
 * 抽象接口 `ISkillAgentTaskQueue` 定义三组能力：
 *   1) agent 队列 (List + Set)：enqueueAgent / dequeueAgent / requeueAgent / removeAgent
 *   2) tasks-mutex（保护 `_tasks.json` 读改写，TTL 秒级）：withTasksMutex
 *   3) extract-lock（Worker 独占 agent 抽取权，TTL 10 min）：acquire/renew/releaseExtractLock
 *
 * 生产实现走 Redis（`RedisSkillAgentTaskQueue`，本文件），
 * 测试实现走内存（`LocalSkillAgentTaskQueue`，本文件）。
 *
 * agent tuple 序列化格式：
 *   `{space}|{user}|{team}|{agent}` — 与 Redis List 元素、锁 key 后缀完全一致。
 */

import { randomUUID } from "node:crypto";

// ── Common types ──────────────────────────────────────────────────────────

/**
 * Agent 五元组: (instance_id, space_id, user_id, team_id, agent_id)。
 *
 * 2026-07-30 由 4 段扩展到 5 段: 新增 instance_id，让 worker 从队列元素
 * 本身能路由到对应 instance 的 CoS / VDB / LLM 资源, 不再依赖"per-instance
 * 绑资源的 worker"这个历史耦合。详见
 * docs/design/2026-07-30-skill-worker-instance-decoupling.md。
 *
 * 兼容:
 *   - parseAgentTuple 收到 4 段字符串 → instance_id = "__legacy__"，
 *     由上层 worker 见到 __legacy__ 时丢弃 + error log。
 *   - 各段禁止含 `|`（跟 add-handler 里的 ID_FORBIDDEN_CHAR 对齐），
 *     serialize 检测到会抛。
 */
export interface AgentTuple {
  instance_id: string;
  space_id: string;
  user_id: string;
  team_id: string;
  agent_id: string;
}

/** 老 4 段 tuple 反序列化时的兜底 instance_id 值。见 AgentTuple 注释。 */
export const LEGACY_INSTANCE_ID = "__legacy__";

const TUPLE_FORBIDDEN_CHAR = "|";

function assertTupleField(name: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`[skill-agent-queue] ${name} must be a non-empty string`);
  }
  if (value.includes(TUPLE_FORBIDDEN_CHAR)) {
    throw new Error(
      `[skill-agent-queue] ${name} cannot contain '${TUPLE_FORBIDDEN_CHAR}': got ${JSON.stringify(value)}`,
    );
  }
}

export function serializeAgentTuple(a: AgentTuple): string {
  assertTupleField("instance_id", a.instance_id);
  assertTupleField("space_id", a.space_id);
  assertTupleField("user_id", a.user_id);
  assertTupleField("team_id", a.team_id);
  assertTupleField("agent_id", a.agent_id);
  return `${a.instance_id}|${a.space_id}|${a.user_id}|${a.team_id}|${a.agent_id}`;
}

export function parseAgentTuple(raw: string): AgentTuple | null {
  if (!raw) return null;
  const parts = raw.split("|");
  if (parts.length === 5) {
    const [instance_id, space_id, user_id, team_id, agent_id] = parts;
    if (!instance_id || !space_id || !user_id || !team_id || !agent_id) return null;
    return { instance_id, space_id, user_id, team_id, agent_id };
  }
  if (parts.length === 4) {
    // Legacy 4 段: 升级过渡期 Redis 里可能有老格式残留。视为 __legacy__，
    // 上层 worker 拿到会丢弃并 error log。这里不返回 null 是为了让上层
    // 能明确识别为 legacy 而不是解析错误 (返回 null 会当作损坏数据处理)。
    const [space_id, user_id, team_id, agent_id] = parts;
    if (!space_id || !user_id || !team_id || !agent_id) return null;
    return {
      instance_id: LEGACY_INSTANCE_ID,
      space_id,
      user_id,
      team_id,
      agent_id,
    };
  }
  return null;
}

export interface ExtractLockHandle {
  key: string;      // agent tuple 序列化后的字符串
  token: string;    // 释放/续约凭证
}

/**
 * peekAgent 实现策略, 反映底层 Redis 的能力级别 (三级兜底):
 *
 *   - "lmove"                — 原生 LMOVE k k RIGHT LEFT (Redis 6.2+), 服务端原子
 *   - "evalsha"              — SCRIPT LOAD + EVALSHA (Redis 2.6+), lua 单线程原子等价
 *   - "eval"                 — 每次 EVAL 全脚本 (evalsha 失败但 eval 可用时的中间态; 目前未使用)
 *   - "rpop_lpush_downgrade" — 最后兜底: 只做 RPOP, 由 caller (extract-worker) 在 tasks-mutex
 *                              内自行 requeue。**非原子**, 有 v1 §4.5 的毫秒窗口, 走这条路径
 *                              时必须打开 selfHealScan 周期性扫描兜底
 *
 * 策略由 `RedisSkillAgentTaskQueue.probePeekStrategy` 在首次 peekAgent 调用时探测,
 * 结果缓存到实例, 之后每次直接分支。详见 docs/design/2026-07-21-skill-worker-crash-recovery.md §5.
 */
export type PeekStrategy = "lmove" | "evalsha" | "eval" | "rpop_lpush_downgrade";

export interface ISkillAgentTaskQueue {
  // ── Agent queue ──
  /**
   * 幂等入队。Set 已含则不重复 LPUSH。返回本次是否是"新入队"（首次进入 Set 返回 true）。
   */
  enqueueAgent(tuple: AgentTuple): Promise<boolean>;
  /**
   * BRPOP-style 出队。阻塞直到有元素或超时；超时返回 null。
   * 注意：出队仅从 List 弹出，Set 不删除（Worker 会在处理完后决定 requeue 还是 remove）。
   */
  dequeueAgent(blockMs: number): Promise<AgentTuple | null>;
  /**
   * At-least-once peek: 拿到 agent 后, agent 仍留在 List 里 (原子 LMOVE 语义:
   * pop tail → push head)。任何时刻 worker 崩溃, 下一轮 peek/dequeue 都能重新拿到,
   * 彻底封闭 v1 §4.5 遗留的"取出但未处理完"毫秒窗口。
   *
   * 语义:
   *   - blockMs=0    → 尝试一次 peek 就返回 (List 空立即 null)
   *   - blockMs>0    → 每 pollIntervalMs 轮询一次直到拿到或超时, 超时 null
   *   - 拿到时: agent 在 List 中的位置 = 队头 (等价 RPOP + LPUSH), 下一次 peek 仍能拿到同 agent
   *
   * 三级兜底见 `PeekStrategy`; 走 rpop_lpush_downgrade 时 caller 必须自行 requeue (原子性丢失)。
   */
  peekAgent(blockMs: number): Promise<AgentTuple | null>;
  /**
   * 返回当前底层实际使用的 peek 策略。extract-worker 用来判断是否走降级路径 (需要显式 requeue)。
   * 调用前若未跑过探测, 返回默认值 (通常是 "lmove", 乐观预设)。
   */
  getPeekStrategy(): PeekStrategy;
  /**
   * 处理完 tasks 仍非空时调用，塞回队头（等价排到队尾轮转）。Set 保持。
   */
  requeueAgent(tuple: AgentTuple): Promise<void>;
  /**
   * tasks 空时下线该 agent：SREM Set；如果 List 里还有残留则一并清理。
   */
  removeAgent(tuple: AgentTuple): Promise<void>;

  /**
   * 按 raw 字符串强制清除 Set + List 残留 (跳过 tuple serialize)。
   *
   * 2026-08-03: peek 语义下 legacy 4 段 tuple 会被 LMOVE 反复搬回队头, 造成
   * loop 空转。用这个接口让 caller 按原始字符串直接 SREM + LREM 清除。
   * 也用作 selfHealScan 里对 legacy 4 段残留的清理。
   */
  purgeRawAgent(raw: string): Promise<void>;

  // ── selfHealScan 需要的原语 (2026-08-03 crash-recovery PR-3) ──────────────
  /**
   * 一次性快照 pending-agents-set 的所有 raw 字符串, 供 selfHealScan 遍历。
   * Redis 用 SMEMBERS, Local 返回 Array.from(set)。
   */
  scanAgentSet(): Promise<string[]>;

  /**
   * 查 List 里是否含指定 raw。Redis 用 LPOS (6.0.6+), Local 遍历数组。
   */
  listContains(raw: string): Promise<boolean>;

  /**
   * 按 raw 字符串直接 LPUSH 到 List, 跳过 SADD (调用方保证 Set 已存在)。
   * selfHealScan 补 List 时用: 已经 SMEMBERS 拿到 raw 说明 Set 里就有, 只补 List。
   */
  enqueueRawAgent(raw: string): Promise<void>;

  // ── tasks-mutex（短锁保护 `_tasks.json` 读改写） ──
  /**
   * 争抢 tasks-mutex 执行 fn，失败时**退避重试直到 waitDeadlineMs**，锁本身有 lockTtlMs 兜底防死锁。
   *
   * 两个参数分离的原因（旧实现把 deadline 和 ttl 用同一值 → 30 并发同 agent 全 timeout 500）：
   *   - `lockTtlMs`：锁自身在 Redis 上的过期时间；用于持锁进程崩溃时兜底自动释放（几秒足够）。
   *   - `waitDeadlineMs`：调用方最多愿意阻塞多久排队；应该 >> lockTtlMs，
   *     覆盖 N 个并发排队所需的累计临界区时长（例如 30 个 300ms 临界区 = 9s，
   *     waitDeadline 至少 15-30s 才不误报 timeout）。
   */
  withTasksMutex<T>(
    tuple: AgentTuple,
    opts: { lockTtlMs: number; waitDeadlineMs: number },
    fn: () => Promise<T>,
  ): Promise<T>;

  // ── extract-lock（Worker 独占 agent 抽取权） ──
  acquireExtractLock(tuple: AgentTuple, ttlMs: number): Promise<ExtractLockHandle | null>;
  renewExtractLock(handle: ExtractLockHandle, ttlMs: number): Promise<boolean>;
  releaseExtractLock(handle: ExtractLockHandle): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────────
// Local (in-memory) implementation — 单元测试专用
// ────────────────────────────────────────────────────────────────────────────

interface WaitingConsumer {
  resolve: (t: AgentTuple | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LocalSkillAgentTaskQueue implements ISkillAgentTaskQueue {
  private readonly list: string[] = [];      // 头 = LPUSH, 尾 = RPOP —— 匹配 Redis 语义
  private readonly set = new Set<string>();
  private readonly tasksMutex = new Map<string, { token: string; expireAt: number }>();
  private readonly extractLocks = new Map<string, { token: string; expireAt: number }>();
  private readonly waiters: WaitingConsumer[] = [];

  private notify(): void {
    while (this.waiters.length > 0 && this.list.length > 0) {
      const w = this.waiters.shift()!;
      clearTimeout(w.timer);
      const raw = this.list.pop()!; // RPOP
      const parsed = parseAgentTuple(raw);
      w.resolve(parsed);
    }
  }

  async enqueueAgent(tuple: AgentTuple): Promise<boolean> {
    const key = serializeAgentTuple(tuple);
    const added = !this.set.has(key);
    if (added) {
      this.set.add(key);
      this.list.unshift(key); // LPUSH
    }
    this.notify();
    return added;
  }

  async dequeueAgent(blockMs: number): Promise<AgentTuple | null> {
    if (this.list.length > 0) {
      const raw = this.list.pop()!; // RPOP
      return parseAgentTuple(raw);
    }
    if (blockMs <= 0) return null;
    return new Promise<AgentTuple | null>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(null);
      }, blockMs);
      this.waiters.push({ resolve, timer });
    });
  }

  /**
   * at-least-once peek: 内存版本 = 单进程 Node, pop + unshift 天然原子。
   * 语义等价 Redis 6.2+ 的 LMOVE k k RIGHT LEFT。
   */
  async peekAgent(blockMs: number): Promise<AgentTuple | null> {
    const deadline = Date.now() + Math.max(0, blockMs);
    while (true) {
      if (this.list.length > 0) {
        const raw = this.list.pop()!;    // RPOP
        this.list.unshift(raw);          // LPUSH
        return parseAgentTuple(raw);
      }
      if (blockMs === 0) return null;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      // Node 内存实现里没 Redis 那种阻塞唤醒, 轮询 20 ms 即可
      await sleep(Math.min(20, remaining));
    }
  }

  getPeekStrategy(): PeekStrategy {
    return "lmove"; // 语义等价, 单进程内存原子
  }

  async requeueAgent(tuple: AgentTuple): Promise<void> {
    const key = serializeAgentTuple(tuple);
    // 塞回队头（LPUSH 语义）；Set 保持
    this.set.add(key);
    this.list.unshift(key);
    this.notify();
  }

  async removeAgent(tuple: AgentTuple): Promise<void> {
    const key = serializeAgentTuple(tuple);
    this.set.delete(key);
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i] === key) this.list.splice(i, 1);
    }
  }

  async purgeRawAgent(raw: string): Promise<void> {
    this.set.delete(raw);
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i] === raw) this.list.splice(i, 1);
    }
  }

  async scanAgentSet(): Promise<string[]> {
    return Array.from(this.set);
  }

  async listContains(raw: string): Promise<boolean> {
    return this.list.includes(raw);
  }

  async enqueueRawAgent(raw: string): Promise<void> {
    this.list.unshift(raw);
    this.notify();
  }

  // ── mutex ──

  async withTasksMutex<T>(
    tuple: AgentTuple,
    opts: { lockTtlMs: number; waitDeadlineMs: number },
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = `mutex:${serializeAgentTuple(tuple)}`;
    const deadline = Date.now() + opts.waitDeadlineMs;
    while (true) {
      const now = Date.now();
      const cur = this.tasksMutex.get(key);
      if (!cur || cur.expireAt <= now) {
        const token = randomUUID();
        this.tasksMutex.set(key, { token, expireAt: now + opts.lockTtlMs });
        try {
          return await fn();
        } finally {
          const held = this.tasksMutex.get(key);
          if (held && held.token === token) this.tasksMutex.delete(key);
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`[skill-agent-queue] tasks-mutex wait timeout for ${key}`);
      }
      await sleep(10);
    }
  }

  // ── extract lock ──

  async acquireExtractLock(tuple: AgentTuple, ttlMs: number): Promise<ExtractLockHandle | null> {
    const key = serializeAgentTuple(tuple);
    const now = Date.now();
    const cur = this.extractLocks.get(key);
    if (cur && cur.expireAt > now) return null;
    const token = randomUUID();
    this.extractLocks.set(key, { token, expireAt: now + ttlMs });
    return { key, token };
  }

  async renewExtractLock(handle: ExtractLockHandle, ttlMs: number): Promise<boolean> {
    const cur = this.extractLocks.get(handle.key);
    if (!cur || cur.token !== handle.token) return false;
    cur.expireAt = Date.now() + ttlMs;
    return true;
  }

  async releaseExtractLock(handle: ExtractLockHandle): Promise<void> {
    const cur = this.extractLocks.get(handle.key);
    if (!cur) return;
    if (cur.token !== handle.token) return;
    this.extractLocks.delete(handle.key);
  }

  // ── test helpers ──

  /** For tests: peek current state. */
  _snapshot(): { list: string[]; set: string[] } {
    return { list: [...this.list], set: [...this.set] };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ────────────────────────────────────────────────────────────────────────────
// Redis implementation
// ────────────────────────────────────────────────────────────────────────────

/**
 * 最小 ioredis 客户端子集，避免直接 import Redis 类型（保持与现有 redis-queue-v2 一致）。
 *
 * 2026-08-03: `lmove` / `evalsha` / `script` 三个方法被 peekAgent 用作三级兜底探测。
 * 三者都是 optional —— 老/降级 Redis 上可能没有 (LMOVE < 6.2)、被禁 (集群策略禁 EVAL) 或
 * 被 client 库省略。缺失时 peekAgent 会按顺序自动降级到下一层。
 */
export interface RedisLike {
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  lpush(key: string, ...values: string[]): Promise<number>;
  lrem(key: string, count: number, value: string): Promise<number>;
  brpop(key: string, timeoutSec: number): Promise<[string, string] | null>;
  rpop(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  pexpire(key: string, ms: number): Promise<number>;
  // ── Optional (探测时按需调用, 缺失 → 走下一级兜底) ──
  lmove?(src: string, dst: string, srcSide: string, dstSide: string): Promise<string | null>;
  evalsha?(sha: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  script?(subcommand: string, ...args: string[]): Promise<string>;
  /**
   * LPOS 查询 raw 在 List 中的位置 (Redis 6.0.6+); null = 不在。缺失时降级到
   * `LRANGE + JS 遍历`, 见 RedisSkillAgentTaskQueue.listContains 实现。
   */
  lpos?(key: string, value: string): Promise<number | null>;
  /** LRANGE 用作 lpos 不可用时的兜底。 */
  lrange?(key: string, start: number, stop: number): Promise<string[]>;
}

export interface RedisSkillAgentTaskQueueOptions {
  client: RedisLike;
  /** Redis key 前缀，默认 "skill"。 */
  keyPrefix?: string;
  /**
   * dequeueAgent 轮询间隔 ms，默认 200。
   *
   * 2026-07-21 —— 历史上 dequeueAgent 走的是 `BRPOP <key> 5`,零延迟唤醒是
   * 拿到了,但 BRPOP 是**阻塞命令**,共用同一条 ioredis 连接的其他 skill
   * 命令 (`SET NX PX` 抢 tasks-mutex、`SADD`/`LPUSH` enqueueAgent、`EVAL`
   * 释放锁) 全部要排在 BRPOP 后面等,handler 每次归档撞 3 次 BRPOP 窗口
   * ≈ 15s。改成非阻塞 `RPOP` + `setTimeout(pollIntervalMs)` 轮询后,主
   * 连接不再被卡,handler 侧 Redis IO 恢复毫秒级；代价是最坏 pollInterval
   * 的唤醒延迟(默认 200ms,skill 抽取本身 LLM 十几秒,这点延迟无感)。
   *
   * 语义跟 memory 侧 `RedisStateBackend.consumeTask` 对齐
   * (redis-backend.ts:312 —— XREADGROUP 不带 BLOCK,外层 sleep 200ms)。
   */
  pollIntervalMs?: number;
}

/**
 * Redis key 前缀默认值。
 *
 * 生产建议：wire 层传入形如 `${memoryPrefix}:skill-conv` 的前缀，跟 memory 的
 * `keyPrefix`（例如 `tdai_memory_prod_v3`）挂钩，避免不同环境的 Redis
 * key 撞。默认值 `"skill-conv"` 只在没显式传时兜底。
 */
const DEFAULT_PREFIX = "skill-conv";

const LUA_RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const LUA_RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * peek lua: 原子 "RPOP tail + LPUSH head", 语义等价 LMOVE k k RIGHT LEFT。
 * 只在 Redis < 6.2 走 EVALSHA/EVAL 兜底时使用。
 *
 * KEYS[1] = pending-agents list
 * return  = 拿到的 raw (string) 或 nil
 */
const LUA_PEEK = `
local raw = redis.call('RPOP', KEYS[1])
if raw then
  redis.call('LPUSH', KEYS[1], raw)
end
return raw
`;

/**
 * 判断一个 Redis 错误消息是否说明"命令不支持" (LMOVE 在 Redis < 6.2 或某些 mock)。
 * 语义边界: 只匹配"命令不认识 / 未启用"这一类, 其他错误 (连接断、认证失败) 必须穿透
 * 抛给 caller, 避免误判导致降级到非原子路径。
 */
function isUnknownCommand(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  return /ERR\s+unknown command/i.test(msg) || /command\s+.*\s+is not allowed/i.test(msg);
}

/**
 * 判断是否 EVALSHA 返回的 NOSCRIPT (Redis 重启 / 脚本缓存被清)。收到 NOSCRIPT 时
 * 应该重新 SCRIPT LOAD 再 EVALSHA, 而不是当成失败降级。
 */
function isNoScript(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  return /NOSCRIPT/i.test(msg);
}

/**
 * 判断是否 EVAL / SCRIPT 被集群策略拒 (permission / 集群禁用)。这一类跟
 * unknown-command 同样是"能力不支持", 需要降级到下一层。
 */
function isEvalDisabled(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  return (
    /command\s+'?EVAL'?\s+is not allowed/i.test(msg) ||
    /NOPERM/i.test(msg) ||
    /ERR\s+unknown command\s+'?(EVAL|EVALSHA|SCRIPT)/i.test(msg)
  );
}

export class RedisSkillAgentTaskQueue implements ISkillAgentTaskQueue {
  private readonly client: RedisLike;
  private readonly listKey: string;
  private readonly setKey: string;
  private readonly extractLockPrefix: string;
  private readonly tasksMutexPrefix: string;
  private readonly pollIntervalMs: number;

  constructor(opts: RedisSkillAgentTaskQueueOptions) {
    this.client = opts.client;
    this.pollIntervalMs = opts.pollIntervalMs ?? 200;
    const prefix = opts.keyPrefix ?? DEFAULT_PREFIX;
    // key 布局（对齐 §5 & §21.5）：
    //   {prefix}:pending-agents         — List (LPUSH 入队 / RPOP 轮询出队)
    //   {prefix}:pending-agents-set     — Set (SADD/SREM 幂等去重)
    //   {prefix}:extract-lock:{tuple}   — Worker 独占 agent 抽取权 (10min TTL)
    //   {prefix}:tasks-mutex:{tuple}    — 保护 _tasks.json 读改写 (5s TTL)
    this.listKey = `${prefix}:pending-agents`;
    this.setKey = `${prefix}:pending-agents-set`;
    this.extractLockPrefix = `${prefix}:extract-lock:`;
    this.tasksMutexPrefix = `${prefix}:tasks-mutex:`;
  }

  async enqueueAgent(tuple: AgentTuple): Promise<boolean> {
    const raw = serializeAgentTuple(tuple);
    const added = await this.client.sadd(this.setKey, raw);
    if (added === 1) {
      await this.client.lpush(this.listKey, raw);
      return true;
    }
    return false;
  }

  async dequeueAgent(blockMs: number): Promise<AgentTuple | null> {
    // 非阻塞 RPOP + sleep 轮询,拒绝 BRPOP。见 pollIntervalMs 处的注释。
    //
    // blockMs=0 —— 只试一次,list 空立刻返回 null。
    // blockMs>0 —— 每 pollIntervalMs 试一次,直到拿到元素或超过 deadline。
    const deadline = Date.now() + Math.max(0, blockMs);
    while (true) {
      const raw = await this.client.rpop(this.listKey);
      if (raw !== null) return parseAgentTuple(raw);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      // pollInterval 与 remaining 取小,保证 blockMs 小于 pollInterval 时能按预期尽快返回。
      await sleep(Math.min(this.pollIntervalMs, remaining));
    }
  }

  /**
   * At-least-once peek — 详见 ISkillAgentTaskQueue.peekAgent 文档 + docs/design/2026-07-21 §5。
   *
   * 主线走 Redis 6.2+ 的 `LMOVE k k RIGHT LEFT`; 老 Redis 通过 LUA_PEEK 脚本走 EVALSHA;
   * EVAL 被禁时降级到非原子 RPOP (caller 负责在 mutex 内 requeue)。
   *
   * 探测: 首次调用时通过 `probePeekStrategy` 决定策略并缓存 (幂等, 并发安全)。
   */
  async peekAgent(blockMs: number): Promise<AgentTuple | null> {
    if (!this.peekProbed) await this.probePeekStrategy();
    const deadline = Date.now() + Math.max(0, blockMs);
    while (true) {
      const raw = await this.executePeek();
      if (raw !== null) return parseAgentTuple(raw);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await sleep(Math.min(this.pollIntervalMs, remaining));
    }
  }

  getPeekStrategy(): PeekStrategy {
    return this.peekStrategy;
  }

  // ── peek 三级兜底探测 ─────────────────────────────────────────────────
  //
  // 首次 peekAgent 调用触发一次探测, 结果缓存到 peekStrategy 之后每次直接分支。
  // 探测本身也可能拿到元素 (对空 list LMOVE 返回 null, no-op; 对非空 list LMOVE
  // 拿到元素后仍留在 List, 语义正确)。
  //
  // 并发安全: 用 `probePromise` 保证并发首次调用只跑一次探测, 其它 caller 等这一次
  // 探测的结果。探测抛错 (非"能力不支持") 时不缓存, 下次仍会再探。

  private peekStrategy: PeekStrategy = "lmove";     // 乐观默认
  private peekScriptSha: string | null = null;
  private peekProbed = false;
  private probePromise: Promise<void> | null = null;

  private async probePeekStrategy(): Promise<void> {
    if (this.peekProbed) return;
    if (this.probePromise) {
      await this.probePromise;
      return;
    }
    this.probePromise = (async () => {
      // Level 1: 探 LMOVE。对着真实的 listKey 试一次 —— 拿到 null 也算探测成功
      // (只要不抛 unknown-command)。对非空 list, 拿到的元素仍在 List 中, 语义正确。
      try {
        if (typeof this.client.lmove === "function") {
          await this.client.lmove(this.listKey, this.listKey, "RIGHT", "LEFT");
          this.peekStrategy = "lmove";
          this.peekProbed = true;
          return;
        }
      } catch (err) {
        if (!isUnknownCommand(err)) throw err; // 非能力问题穿透
      }

      // Level 2: 探 EVALSHA + SCRIPT LOAD。
      if (typeof this.client.script === "function" && typeof this.client.evalsha === "function") {
        try {
          this.peekScriptSha = await this.client.script("LOAD", LUA_PEEK);
          // 立即用一次 EVALSHA 验证能跑 (对空 list 返回 null 亦 OK)
          await this.client.evalsha(this.peekScriptSha, 1, this.listKey);
          this.peekStrategy = "evalsha";
          this.peekProbed = true;
          return;
        } catch (err) {
          if (!isEvalDisabled(err) && !isUnknownCommand(err)) throw err;
        }
      }

      // Level 3: 最后兜底 —— 非原子 RPOP。
      // 打 P1 告警; caller (extract-worker) 需要通过 getPeekStrategy 判断走这条路径时
      // 自己在 tasks-mutex 内做显式 requeue (v1 §4.5 原方案), 并且 pool 侧要打开周期性
      // selfHealScan (PR-3 交付)。
      this.peekStrategy = "rpop_lpush_downgrade";
      this.peekProbed = true;
    })().finally(() => {
      this.probePromise = null;
    });
    await this.probePromise;
  }

  private async executePeek(): Promise<string | null> {
    switch (this.peekStrategy) {
      case "lmove":
        // 探测成功后不会再走 unknown-command 分支; 这里也不再兜底降级 (让错误穿透), 避免
        // 中途 Redis 版本切换导致的隐蔽降级。
        return this.client.lmove!(this.listKey, this.listKey, "RIGHT", "LEFT");

      case "evalsha":
        try {
          return (await this.client.evalsha!(this.peekScriptSha!, 1, this.listKey)) as
            | string
            | null;
        } catch (err) {
          if (isNoScript(err)) {
            // Redis 重启导致脚本缓存丢失: 补 LOAD 再 EVALSHA 一次。
            // 只重试一次, 二次仍 NOSCRIPT 就穿透 (说明 client 或 server 有异常, 不该悄悄降级)。
            this.peekScriptSha = await this.client.script!("LOAD", LUA_PEEK);
            return (await this.client.evalsha!(this.peekScriptSha, 1, this.listKey)) as
              | string
              | null;
          }
          throw err;
        }

      case "eval":
        return (await this.client.eval(LUA_PEEK, 1, this.listKey)) as string | null;

      case "rpop_lpush_downgrade": {
        // 非原子: 只 RPOP, caller 在 mutex 内自己 requeue。语义等同 dequeueAgent 一次 pop。
        return this.client.rpop(this.listKey);
      }
    }
  }

  async requeueAgent(tuple: AgentTuple): Promise<void> {
    const raw = serializeAgentTuple(tuple);
    // 幂等：保证 Set 里也在
    await this.client.sadd(this.setKey, raw);
    await this.client.lpush(this.listKey, raw);
  }

  async removeAgent(tuple: AgentTuple): Promise<void> {
    const raw = serializeAgentTuple(tuple);
    await this.client.srem(this.setKey, raw);
    // List 里可能还有残留（Worker 已经 pop 就没了；此处兜底）
    await this.client.lrem(this.listKey, 0, raw);
  }

  async purgeRawAgent(raw: string): Promise<void> {
    // 直接按 raw 字符串清 Set + List, 不走 tuple serialize。用于 legacy 4 段清理
    // + selfHealScan 里对损坏残留的兜底。
    await this.client.srem(this.setKey, raw);
    await this.client.lrem(this.listKey, 0, raw);
  }

  async scanAgentSet(): Promise<string[]> {
    return this.client.smembers(this.setKey);
  }

  async listContains(raw: string): Promise<boolean> {
    if (typeof this.client.lpos === "function") {
      const pos = await this.client.lpos(this.listKey, raw);
      return pos !== null && pos >= 0;
    }
    if (typeof this.client.lrange === "function") {
      // 兜底: LRANGE 拿全量遍历。规模上 List 长度 = 活跃 agent, 一般 <= 千级, 可接受。
      const all = await this.client.lrange(this.listKey, 0, -1);
      return all.includes(raw);
    }
    // 都缺 → 保守认为 List 里有 (少补一次 LPUSH 强于误重复 LPUSH; 反正下一轮
    // selfHealScan 会再来一次)。
    return true;
  }

  async enqueueRawAgent(raw: string): Promise<void> {
    // Set 已在 (caller 保证), 只需要补 List。
    await this.client.lpush(this.listKey, raw);
  }

  async withTasksMutex<T>(
    tuple: AgentTuple,
    opts: { lockTtlMs: number; waitDeadlineMs: number },
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = this.tasksMutexPrefix + serializeAgentTuple(tuple);
    const token = randomUUID();
    const deadline = Date.now() + opts.waitDeadlineMs;
    while (true) {
      // SET NX PX：短 TTL 兜底崩溃场景；waitDeadline 覆盖并发排队时间
      const ok = await this.client.set(key, token, "NX", "PX", opts.lockTtlMs);
      if (ok === "OK") {
        try {
          return await fn();
        } finally {
          try {
            await this.client.eval(LUA_RELEASE, 1, key, token);
          } catch {
            /* swallow */
          }
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`[skill-agent-queue] tasks-mutex wait timeout for ${key}`);
      }
      await sleep(20 + Math.floor(Math.random() * 30));
    }
  }

  async acquireExtractLock(tuple: AgentTuple, ttlMs: number): Promise<ExtractLockHandle | null> {
    const key = this.extractLockPrefix + serializeAgentTuple(tuple);
    const token = randomUUID();
    const ok = await this.client.set(key, token, "NX", "PX", ttlMs);
    if (ok !== "OK") return null;
    return { key, token };
  }

  async renewExtractLock(handle: ExtractLockHandle, ttlMs: number): Promise<boolean> {
    const raw = handle.key.startsWith(this.extractLockPrefix)
      ? handle.key
      : this.extractLockPrefix + handle.key;
    const result = await this.client.eval(LUA_RENEW, 1, raw, handle.token, ttlMs);
    return result === 1;
  }

  async releaseExtractLock(handle: ExtractLockHandle): Promise<void> {
    const raw = handle.key.startsWith(this.extractLockPrefix)
      ? handle.key
      : this.extractLockPrefix + handle.key;
    try {
      await this.client.eval(LUA_RELEASE, 1, raw, handle.token);
    } catch {
      /* swallow */
    }
  }
}
