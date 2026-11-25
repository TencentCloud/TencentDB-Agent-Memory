/**
 * Turn 序号计数 —— 宿主侧无状态推导。
 *
 * 一个 trace = 一个 turn（一次用户输入）。一个 turn 内的工具循环会产生多次 upstream
 * 请求，它们必须算出**相同**的 turn 序号，才能在 Langfuse 中归并到同一个 trace。
 *
 * 由于宿主侧没有逐请求的持久状态（turn 计数器在私有模块内部，不对外
 * 暴露逐 turn 序号），这里直接从 `messages` 历史推导：统计消息序列里"人类输入轮次"的
 * 数量。规则与私有模块的 turn 检测逻辑对齐：
 *   - Anthropic：user 消息含非 <system-reminder> 的 text block 即为人类输入；
 *     纯 tool_result / 纯 system-reminder 是工具循环延续。
 *   - OpenAI：role=user 且含非 <system-reminder> 文本为人类输入；role=tool 是工具循环。
 *
 * 因此：一个 turn 的首次请求与其后续工具循环请求，因为"人类轮次数"相同，turnSeq 一致。
 * 下一个 turn 的请求会多出一条人类输入 → turnSeq +1 → 新 trace。
 *
 * 注意：依赖客户端发送完整历史（Claude Code / CodeBuddy 均如此）。若客户端截断历史，
 * turnSeq 可能偏移，但同一 turn 内仍保持一致（只是绝对值漂移），不影响"同 turn 归一 trace"。
 * 绝对值漂移会让序号**回退**（现网见过 97 → 1），与该会话早先写出的用量行撞号——
 * 开了 Redis 时由 `resolveMonotonicTurnSeq()` 把本地推导值换成会话级单调序号。
 */

import type { ProxyConfig } from "./types.js";
import { getRedisClient } from "./db/redis-client.js";
import { log } from "./report/log.js";

/** 判断单条 user 消息内容是否为人类输入（非工具循环延续）。 */
function isHumanUserContent(content: unknown): boolean {
  if (typeof content === "string") {
    return !content.startsWith("<system-reminder>");
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b && typeof b === "object" && b.type === "text") {
        const text = (b.text as string) ?? "";
        if (!text.startsWith("<system-reminder>")) return true;
      }
    }
    return false;
  }
  return false;
}

/**
 * 统计 messages 中"人类输入轮次"的数量，作为当前 turn 序号。
 *
 * 返回值 ≥ 1（至少当前这一轮）；空消息或无人类输入时返回 0。
 */
export function countHumanTurns(messages: unknown[], protocol: "openai" | "anthropic"): number {
  let count = 0;
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    if (m?.role !== "user") continue;
    // OpenAI 的工具响应是 role=tool（不会进入这里）；user 消息按内容判断。
    if (protocol === "openai" || protocol === "anthropic") {
      if (isHumanUserContent(m.content)) count += 1;
    }
  }
  return count;
}

/**
 * OpenAI Responses API (codex / workbuddy) 版本 —— 数 body.input[] 里
 * type="message" && role="user" 的项。
 *
 * 与 openai/anthropic 版本对齐: 同 turn 内的工具循环 (function_call +
 * function_call_output) 不新增 user message → 相同 turnSeq → 同一 langfuse trace。
 *
 * 迁移前 codex/wb runner 各自复制了一份实现 (blueprint §2.4 复制粘贴)。
 */
export function countHumanTurnsResponses(input: unknown): number {
  if (!Array.isArray(input)) return 0;
  let count = 0;
  for (const item of input) {
    const it = item as Record<string, unknown> | null;
    if (!it || typeof it !== "object") continue;
    if (it.type !== "message") continue;
    if (it.role !== "user") continue;
    count++;
  }
  return count;
}

// ─── 会话级单调 turn 序号（Redis） ────────────────────────────────────────────

/**
 * 序号状态独占的 key 前缀。
 *
 * 不复用 `config.redis.keyPrefix`（`cg:sess:`）：RedisSessionStore 在
 * `cg:sess:turnseq:<session>` 上放的是一个 INCR 字符串计数器，这里存的是 hash，
 * 同名会直接 WRONGTYPE。
 */
const TURN_SEQ_KEY_PREFIX = "turnseq:";

const DEFAULT_TURN_SEQ_TTL_DAYS = 30;

/**
 * 分配会话级单调 turn 序号。单 key EVAL，多实例下由 Redis 串行化。
 *
 * hash 字段：`seq` = 该会话已发出的最大序号；`k:<lane>` / `s:<lane>` = 每条轨道
 * 上一次的本地标记与对应序号。
 *
 * 标记没变（同一 turn 的工具循环）就复用上次的序号；标记一变就取
 * `max(已发最大值 + 1, 本地值)`：历史完整时序号仍等于人类轮次数，历史被截短
 * （本地值回落）时改走 +1，于是只会前进、不会撞回旧 turn。
 */
const ALLOCATE_TURN_SEQ_LUA = `
local markField = "k:" .. ARGV[1]
local seqField = "s:" .. ARGV[1]
local state = redis.call("HMGET", KEYS[1], markField, seqField, "seq")
local seq
if state[1] == ARGV[2] and state[2] then
  seq = tonumber(state[2])
else
  seq = (tonumber(state[3]) or 0) + 1
  local localSeq = tonumber(ARGV[2]) or 0
  if localSeq > seq then seq = localSeq end
  redis.call("HSET", KEYS[1], markField, ARGV[2], seqField, seq, "seq", seq)
end
redis.call("EXPIRE", KEYS[1], ARGV[3])
return seq
`;

/**
 * 把本地推导的 turn 序号换成该会话在 Redis 上的单调序号。
 *
 * `lane` 用于把共用 sessionKey、但历史长度完全不同的请求流分开计数：Claude Code
 * 的 sidequery / fork 历史只有一两条，与主对话放同一条轨道会互相判成"新 turn"，
 * 把一个 turn 的工具循环拆成两个 trace。
 *
 * 任何一步不可用都原样返回 `localTurnSeq`（Redis 没开、拿不到 client、EVAL 失败、
 * 序号本身就是 0），保持与开 Redis 之前一致的行为——观测口径不值得挡请求。
 */
export async function resolveMonotonicTurnSeq(
  config: ProxyConfig,
  sessionKey: string,
  localTurnSeq: number,
  lane = "main",
): Promise<number> {
  if (localTurnSeq <= 0 || !sessionKey) return localTurnSeq;
  if (!config.redis?.enabled) return localTurnSeq;

  const client = getRedisClient(config.redis);
  if (!client) return localTurnSeq;

  const ttlDays = config.redis.turnSeqTtlDays ?? DEFAULT_TURN_SEQ_TTL_DAYS;
  try {
    const raw = await client.eval(
      ALLOCATE_TURN_SEQ_LUA,
      1,
      `${TURN_SEQ_KEY_PREFIX}${sessionKey}`,
      lane,
      String(localTurnSeq),
      String(Math.max(1, Math.floor(ttlDays * 24 * 3600))),
    );
    const seq = Number(raw);
    return Number.isFinite(seq) && seq > 0 ? seq : localTurnSeq;
  } catch (err) {
    log.warn("turn_seq.allocate_failed", {
      sessionKey,
      lane,
      localTurnSeq,
      error: err instanceof Error ? err.message : String(err),
    });
    return localTurnSeq;
  }
}
