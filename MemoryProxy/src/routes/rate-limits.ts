import type { Context } from "hono";
import type { ProxyConfig } from "../types.js";
import { assertKeySegment } from "../storage/key-utils.js";
import { getRateLimitStore } from "../rate-limit/guard.js";
import type { RedisRateLimitStore } from "../rate-limit/redis-store.js";

interface RateLimitBody {
  instance_id?: unknown;
  model_id?: unknown;
  input_tpm?: unknown;
  qpm?: unknown;
  clear_model_overrides?: unknown;
}

type Scope =
  | { kind: "global" }
  | { kind: "instance"; instanceId: string }
  | { kind: "model"; instanceId: string; modelId: string };

export function createRateLimitHandlers(config: ProxyConfig) {
  return {
    get: (c: Context) => handleGet(c, config),
    put: (c: Context) => handlePut(c, config),
    delete: (c: Context) => handleDelete(c, config),
  };
}

async function handleGet(c: Context, config: ProxyConfig): Promise<Response> {
  const scope = readScope(c.req.query("instance_id"), c.req.query("model_id"));
  if (scope instanceof Error) return error(c, 400, scope.message);

  try {
    const store = getRateLimitStore(config);
    const enabled = config.rateLimit.tpm > 0 || config.rateLimit.qpm > 0;
    const configured = await store.getLimits();

    if (scope.kind === "global") {
      return ok(c, {
        enabled,
        ...configured,
        window_seconds: 60,
        instance_overrides: await store.listInstanceOverrides(),
        overrides: await store.listOverrides(),
      });
    }

    const instanceOverride = await store.getInstanceOverride(scope.instanceId);
    if (scope.kind === "instance") {
      return ok(c, {
        enabled,
        instance_id: scope.instanceId,
        input_tpm: instanceOverride?.tpm ?? configured.tpm,
        qpm: instanceOverride?.qpm ?? configured.qpm,
        source: instanceOverride === null ? "global" : "instance_override",
        global: configured,
        model_overrides: await listModelOverrides(store, scope.instanceId),
      });
    }

    const override = await store.getOverride(scope.instanceId, scope.modelId);
    const inherited = instanceOverride ?? configured;
    return ok(c, {
      enabled,
      instance_id: scope.instanceId,
      model_id: scope.modelId,
      input_tpm: override?.tpm ?? inherited.tpm,
      qpm: override?.qpm ?? inherited.qpm,
      source: override !== null ? "override" : instanceOverride !== null ? "instance_override" : "global",
      instance_override: instanceOverride,
      global: configured,
    });
  } catch (err) {
    return error(c, 503, err instanceof Error ? err.message : String(err));
  }
}

async function handlePut(c: Context, config: ProxyConfig): Promise<Response> {
  const parsed = await parseBody(c);
  if (parsed instanceof Response) return parsed;
  const inputTpm = positiveInteger(parsed.input_tpm);
  if (inputTpm === null) return error(c, 400, "input_tpm must be a positive integer");
  const qpm = positiveInteger(parsed.qpm);
  if (qpm === null) return error(c, 400, "qpm must be a positive integer");
  const scope = readScope(parsed.instance_id, parsed.model_id);
  if (scope instanceof Error) return error(c, 400, scope.message);
  const clearModelOverrides = parsed.clear_model_overrides ?? false;
  if (typeof clearModelOverrides !== "boolean") {
    return error(c, 400, "clear_model_overrides must be a boolean");
  }
  if (clearModelOverrides && scope.kind !== "instance") {
    return error(c, 400, "clear_model_overrides requires instance_id without model_id");
  }

  try {
    const store = getRateLimitStore(config);
    if (scope.kind === "global") {
      await store.setLimits({ tpm: inputTpm, qpm });
      return ok(c, { tpm: inputTpm, qpm });
    }

    if (scope.kind === "instance") {
      await store.setInstanceOverride(scope.instanceId, { tpm: inputTpm, qpm });
      const cleared = clearModelOverrides
        ? await store.deleteOverridesForInstance(scope.instanceId)
        : 0;
      return ok(c, {
        instance_id: scope.instanceId,
        input_tpm: inputTpm,
        qpm,
        cleared_model_overrides: cleared,
        model_overrides: await listModelOverrides(store, scope.instanceId),
      });
    }

    await store.setOverride(scope.instanceId, scope.modelId, { tpm: inputTpm, qpm });
    return ok(c, {
      instance_id: scope.instanceId,
      model_id: scope.modelId,
      input_tpm: inputTpm,
      qpm,
    });
  } catch (err) {
    return error(c, 503, err instanceof Error ? err.message : String(err));
  }
}

async function handleDelete(c: Context, config: ProxyConfig): Promise<Response> {
  const parsed = await parseBody(c);
  if (parsed instanceof Response) return parsed;
  const scope = readScope(parsed.instance_id, parsed.model_id);
  if (scope instanceof Error) return error(c, 400, scope.message);

  try {
    const store = getRateLimitStore(config);
    if (scope.kind === "global") {
      await store.deleteLimits();
      return ok(c, { tpm: config.rateLimit.tpm, qpm: config.rateLimit.qpm });
    }

    if (scope.kind === "instance") {
      await store.deleteInstanceOverride(scope.instanceId);
      return ok(c, { instance_id: scope.instanceId, deleted: true });
    }

    await store.deleteOverride(scope.instanceId, scope.modelId);
    return ok(c, {
      instance_id: scope.instanceId,
      model_id: scope.modelId,
      deleted: true,
    });
  } catch (err) {
    return error(c, 503, err instanceof Error ? err.message : String(err));
  }
}

async function listModelOverrides(store: RedisRateLimitStore, instanceId: string) {
  return (await store.listOverrides())
    .filter((override) => override.instanceId === instanceId)
    .map(({ modelId, tpm, qpm }) => ({ model_id: modelId, input_tpm: tpm, qpm }));
}

async function parseBody(c: Context): Promise<RateLimitBody | Response> {
  try {
    return await c.req.json<RateLimitBody>();
  } catch {
    return error(c, 400, "invalid JSON body");
  }
}

function readScope(rawInstanceId: unknown, rawModelId: unknown): Scope | Error {
  const instanceId = typeof rawInstanceId === "string" ? rawInstanceId.trim() : "";
  const modelId = typeof rawModelId === "string" ? rawModelId.trim() : "";
  if (!instanceId && !modelId) return { kind: "global" };
  if (!instanceId) return new Error("model_id requires instance_id");
  try {
    assertKeySegment("instance_id", instanceId);
    if (!modelId) return { kind: "instance", instanceId };
    validateModelId(modelId);
    return { kind: "model", instanceId, modelId };
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

function validateModelId(modelId: string): void {
  if (modelId.length > 256 || /[\u0000-\u001f]/.test(modelId)) {
    throw new Error("invalid model_id");
  }
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function ok(c: Context, data: Record<string, unknown>): Response {
  return c.json({ code: 0, message: "ok", data });
}

function error(c: Context, status: 400 | 503, message: string): Response {
  return c.json({ code: status, message }, status);
}
