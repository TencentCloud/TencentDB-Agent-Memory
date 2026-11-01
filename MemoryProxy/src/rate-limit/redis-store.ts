import { createHash } from "node:crypto";
import type Redis from "ioredis";
import type { RateLimitConfig } from "../types.js";
import { log } from "../report/log.js";

const WINDOW_SECONDS = 60;

/**
 * Key prefix `{rl}:`. The `{rl}` is a constant Redis Cluster hash tag so every
 * rate-limit key lands on one slot — the CHECK Lua requires it, touching
 * `config`, `overrides` and one dimension's counters in a single EVAL.
 */
const KEY_PREFIX = "{rl}:";

export interface RateLimitDecision {
  allowed: boolean;
  degraded: boolean;
  /** When degraded, why the limiter fell open (real error or "redis_unavailable"). */
  degradedReason?: string;
  reason: "tpm" | "qpm" | null;
  tpm: number;
  qpm: number;
  usedTokens: number;
  usedRequests: number;
  remainingTokens: number;
  remainingRequests: number;
  retryAfterSeconds: number;
}

export interface RateLimitOverride {
  instanceId: string;
  modelId: string;
  tpm: number;
  qpm: number;
}

export interface RateLimitInstanceOverride {
  instanceId: string;
  tpm: number;
  qpm: number;
}

/**
 * Limit precedence: instance × model override > instance override > global
 * (`{rl}:config`, falling back to YAML). Counters stay per instance × model, so
 * an instance override is the quota each of its models gets, not a shared pool.
 */
const CHECK_REQUEST_LUA = `
local tpm = tonumber(redis.call("HGET", KEYS[1], "tpm")) or tonumber(ARGV[2])
local qpm = tonumber(redis.call("HGET", KEYS[1], "qpm")) or tonumber(ARGV[3])

local function applyOverride(raw)
  if not raw then return end
  local ok, value = pcall(cjson.decode, raw)
  if ok and type(value) == "table" then
    tpm = tonumber(value.tpm) or tpm
    qpm = tonumber(value.qpm) or qpm
  else
    tpm = tonumber(raw) or tpm
  end
end

applyOverride(redis.call("HGET", KEYS[7], ARGV[5]))
applyOverride(redis.call("HGET", KEYS[2], ARGV[1]))
local window = tonumber(ARGV[4])
local now = tonumber(redis.call("TIME")[1])
local cutoff = now - window + 1

local function pruneAndSum(timesKey, countsKey)
  local expired = redis.call("ZRANGEBYSCORE", timesKey, "-inf", cutoff - 1)
  if #expired > 0 then
    redis.call("ZREM", timesKey, unpack(expired))
    redis.call("HDEL", countsKey, unpack(expired))
  end
  local sum = 0
  local values = redis.call("HVALS", countsKey)
  for _, value in ipairs(values) do sum = sum + tonumber(value) end
  return sum
end

local function retryAfter(timesKey, countsKey, deficit)
  local released = 0
  local buckets = redis.call("ZRANGE", timesKey, 0, -1, "WITHSCORES")
  for i = 1, #buckets, 2 do
    released = released + tonumber(redis.call("HGET", countsKey, buckets[i]) or "0")
    if released >= deficit then
      return math.max(1, tonumber(buckets[i + 1]) + window - now)
    end
  end
  return window
end

local usedRequests = pruneAndSum(KEYS[3], KEYS[4])
local usedTokens = pruneAndSum(KEYS[5], KEYS[6])

if qpm > 0 and usedRequests + 1 > qpm then
  return {0, 2, tpm, qpm, usedTokens, usedRequests,
    math.max(0, tpm - usedTokens), 0,
    retryAfter(KEYS[3], KEYS[4], usedRequests + 1 - qpm)}
end

if tpm > 0 and usedTokens >= tpm then
  return {0, 1, tpm, qpm, usedTokens, usedRequests,
    0, math.max(0, qpm - usedRequests),
    retryAfter(KEYS[5], KEYS[6], usedTokens - tpm + 1)}
end

local bucket = tostring(now)
redis.call("ZADD", KEYS[3], now, bucket)
redis.call("HINCRBY", KEYS[4], bucket, 1)
redis.call("EXPIRE", KEYS[3], window * 2)
redis.call("EXPIRE", KEYS[4], window * 2)
usedRequests = usedRequests + 1
return {1, 0, tpm, qpm, usedTokens, usedRequests,
  math.max(0, tpm - usedTokens), math.max(0, qpm - usedRequests), 0}
`;

const RECORD_TOKENS_LUA = `
local window = tonumber(ARGV[1])
local amount = tonumber(ARGV[2])
local now = tonumber(redis.call("TIME")[1])
local cutoff = now - window + 1
local expired = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", cutoff - 1)
if #expired > 0 then
  redis.call("ZREM", KEYS[1], unpack(expired))
  redis.call("HDEL", KEYS[2], unpack(expired))
end
local bucket = tostring(now)
redis.call("ZADD", KEYS[1], now, bucket)
redis.call("HINCRBY", KEYS[2], bucket, amount)
redis.call("EXPIRE", KEYS[1], window * 2)
redis.call("EXPIRE", KEYS[2], window * 2)
return 1
`;

export class RedisRateLimitStore {
  private readonly configKey: string;
  private readonly overridesKey: string;
  private readonly instanceOverridesKey: string;

  constructor(
    private readonly client: Redis | null,
    private readonly config: RateLimitConfig,
  ) {
    this.configKey = `${KEY_PREFIX}config`;
    this.overridesKey = `${KEY_PREFIX}overrides`;
    this.instanceOverridesKey = `${KEY_PREFIX}instance-overrides`;
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  /**
   * Redis keys for one `instance × model` dimension. Single source of truth so
   * the CHECK and RECORD paths can never drift onto different keys. The digest
   * bounds key length and neutralizes arbitrary characters in `modelId`.
   */
  private dimensionKeys(instanceId: string, modelId: string) {
    const dimension = dimensionField(instanceId, modelId);
    const digest = createHash("sha256").update(dimension).digest("hex").slice(0, 32);
    return {
      dimension,
      reqIndex: `${KEY_PREFIX}req:${digest}:idx`,
      reqCounts: `${KEY_PREFIX}req:${digest}:cnt`,
      tokIndex: `${KEY_PREFIX}tok:${digest}:idx`,
      tokCounts: `${KEY_PREFIX}tok:${digest}:cnt`,
    };
  }

  async checkRequest(
    instanceId: string,
    modelId: string,
  ): Promise<RateLimitDecision> {
    if (!this.client) return this.degradedDecision();

    const { dimension, reqIndex, reqCounts, tokIndex, tokCounts } =
      this.dimensionKeys(instanceId, modelId);

    try {
      const raw = await this.client.eval(
        CHECK_REQUEST_LUA,
        7,
        this.configKey,
        this.overridesKey,
        reqIndex,
        reqCounts,
        tokIndex,
        tokCounts,
        this.instanceOverridesKey,
        dimension,
        String(this.config.tpm),
        String(this.config.qpm),
        String(WINDOW_SECONDS),
        instanceId,
      ) as Array<number | string>;

      const allowed = Number(raw[0]) === 1;
      return {
        allowed,
        degraded: false,
        reason: Number(raw[1]) === 1 ? "tpm" : Number(raw[1]) === 2 ? "qpm" : null,
        tpm: Number(raw[2]),
        qpm: Number(raw[3]),
        usedTokens: Number(raw[4]),
        usedRequests: Number(raw[5]),
        remainingTokens: Number(raw[6]),
        remainingRequests: Number(raw[7]),
        retryAfterSeconds: Number(raw[8]),
      };
    } catch (err) {
      return this.degradedDecision(err instanceof Error ? err.message : String(err));
    }
  }

  async recordInputTokens(instanceId: string, modelId: string, inputTokens: number): Promise<boolean> {
    if (!this.client || inputTokens <= 0) return false;
    const { tokIndex, tokCounts } = this.dimensionKeys(instanceId, modelId);
    try {
      await this.client.eval(
        RECORD_TOKENS_LUA,
        2,
        tokIndex,
        tokCounts,
        String(WINDOW_SECONDS),
        String(Math.floor(inputTokens)),
      );
      return true;
    } catch (err) {
      log.warn("rate_limit.record_failed", {
        instanceId,
        modelId,
        inputTokens,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async getLimits(): Promise<{ tpm: number; qpm: number }> {
    if (!this.client) throw new Error("Redis unavailable");
    const raw = await this.client.hmget(this.configKey, "tpm", "qpm");
    return {
      tpm: raw[0] ? Number(raw[0]) : this.config.tpm,
      qpm: raw[1] ? Number(raw[1]) : this.config.qpm,
    };
  }

  async setLimits(limits: { tpm?: number; qpm?: number }): Promise<void> {
    this.assertAvailable();
    const values: Record<string, string> = {};
    if (limits.tpm !== undefined) values.tpm = String(limits.tpm);
    if (limits.qpm !== undefined) values.qpm = String(limits.qpm);
    if (Object.keys(values).length > 0) await this.client!.hset(this.configKey, values);
  }

  async deleteLimits(): Promise<void> {
    this.assertAvailable();
    await this.client!.hdel(this.configKey, "tpm", "qpm");
  }

  async getOverride(instanceId: string, modelId: string): Promise<{ tpm: number; qpm: number } | null> {
    this.assertAvailable();
    const raw = await this.client!.hget(this.overridesKey, dimensionField(instanceId, modelId));
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") {
        const value = parsed as Partial<{ tpm: number; qpm: number }>;
        return {
          tpm: Number(value.tpm ?? this.config.tpm),
          qpm: Number(value.qpm ?? this.config.qpm),
        };
      }
      return { tpm: Number(parsed), qpm: this.config.qpm };
    } catch {
      return { tpm: Number(raw), qpm: this.config.qpm };
    }
  }

  async setOverride(
    instanceId: string,
    modelId: string,
    limits: { tpm: number; qpm: number },
  ): Promise<void> {
    this.assertAvailable();
    await this.client!.hset(
      this.overridesKey,
      dimensionField(instanceId, modelId),
      JSON.stringify(limits),
    );
  }

  async deleteOverride(instanceId: string, modelId: string): Promise<void> {
    this.assertAvailable();
    await this.client!.hdel(this.overridesKey, dimensionField(instanceId, modelId));
  }

  async listOverrides(): Promise<RateLimitOverride[]> {
    this.assertAvailable();
    const all = await this.client!.hgetall(this.overridesKey);
    const result: RateLimitOverride[] = [];
    for (const [field, value] of Object.entries(all)) {
      try {
        const [instanceId, modelId] = JSON.parse(field) as [string, string];
        const parsed = JSON.parse(value) as unknown;
        const limits = parsed && typeof parsed === "object"
          ? parsed as { tpm: number; qpm: number }
          : { tpm: Number(parsed), qpm: this.config.qpm };
        result.push({ instanceId, modelId, ...limits });
      } catch {
        // Ignore malformed fields written outside the admin API.
      }
    }
    return result.sort((a, b) =>
      a.instanceId.localeCompare(b.instanceId) || a.modelId.localeCompare(b.modelId)
    );
  }

  /** Removes every instance × model override under `instanceId`; returns how many were removed. */
  async deleteOverridesForInstance(instanceId: string): Promise<number> {
    this.assertAvailable();
    const fields = (await this.listOverrides())
      .filter((override) => override.instanceId === instanceId)
      .map((override) => dimensionField(override.instanceId, override.modelId));
    if (fields.length === 0) return 0;
    return this.client!.hdel(this.overridesKey, ...fields);
  }

  async getInstanceOverride(instanceId: string): Promise<{ tpm: number; qpm: number } | null> {
    this.assertAvailable();
    const raw = await this.client!.hget(this.instanceOverridesKey, instanceId);
    if (raw === null) return null;
    try {
      const value = JSON.parse(raw) as Partial<{ tpm: number; qpm: number }>;
      return {
        tpm: Number(value.tpm ?? this.config.tpm),
        qpm: Number(value.qpm ?? this.config.qpm),
      };
    } catch {
      return null;
    }
  }

  async setInstanceOverride(instanceId: string, limits: { tpm: number; qpm: number }): Promise<void> {
    this.assertAvailable();
    await this.client!.hset(this.instanceOverridesKey, instanceId, JSON.stringify(limits));
  }

  async deleteInstanceOverride(instanceId: string): Promise<void> {
    this.assertAvailable();
    await this.client!.hdel(this.instanceOverridesKey, instanceId);
  }

  async listInstanceOverrides(): Promise<RateLimitInstanceOverride[]> {
    this.assertAvailable();
    const all = await this.client!.hgetall(this.instanceOverridesKey);
    const result: RateLimitInstanceOverride[] = [];
    for (const [instanceId, value] of Object.entries(all)) {
      try {
        const limits = JSON.parse(value) as { tpm: number; qpm: number };
        result.push({ instanceId, tpm: Number(limits.tpm), qpm: Number(limits.qpm) });
      } catch {
        // Ignore malformed fields written outside the admin API.
      }
    }
    return result.sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  }

  private degradedDecision(reason = "redis_unavailable"): RateLimitDecision {
    return {
      allowed: true,
      degraded: true,
      degradedReason: reason,
      reason: null,
      tpm: this.config.tpm,
      qpm: this.config.qpm,
      usedTokens: 0,
      usedRequests: 0,
      remainingTokens: this.config.tpm,
      remainingRequests: this.config.qpm,
      retryAfterSeconds: 0,
    };
  }

  private assertAvailable(): void {
    if (!this.client) throw new Error("Redis unavailable");
  }
}

export function dimensionField(instanceId: string, modelId: string): string {
  return JSON.stringify([instanceId, modelId]);
}
