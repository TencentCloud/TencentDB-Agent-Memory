import type { Context } from "hono";
import type { ProxyConfig } from "../types.js";
import { assertKeySegment } from "../storage/key-utils.js";
import { getRateLimitStore } from "../rate-limit/guard.js";
import { adminAuthError, checkAdminAuth } from "./admin-auth.js";

interface RateLimitBody {
  instance_id?: unknown;
  model_id?: unknown;
  input_tpm?: unknown;
  qpm?: unknown;
}

export function createRateLimitHandlers(config: ProxyConfig) {
  // Admin endpoints must require the admin.apiKey bearer token — otherwise any
  // network caller can tamper with tenant rate limits (issue #672, CWE-306).
  const enforceAuth = (c: Context): Response | null => {
    const result = checkAdminAuth(c, config.admin.apiKey);
    if (result !== "ok") return adminAuthError(c, result);
    return null;
  };

  return {
    get: (c: Context) => enforceAuth(c) || handleGet(c, config),
    put: (c: Context) => enforceAuth(c) || handlePut(c, config),
    delete: (c: Context) => enforceAuth(c) || handleDelete(c, config),
  };
}

async function handleGet(c: Context, config: ProxyConfig): Promise<Response> {
  try {
    const store = getRateLimitStore(config);
    const instanceId = c.req.query("instance_id");
    const modelId = c.req.query("model_id");
    if ((instanceId && !modelId) || (!instanceId && modelId)) {
      return error(c, 400, "instance_id and model_id must be provided together");
    }

    const configured = await store.getLimits();
    if (instanceId && modelId) {
      validateDimension(instanceId, modelId);
      const override = await store.getOverride(instanceId, modelId);
      return ok(c, {
        enabled: config.rateLimit.tpm > 0 || config.rateLimit.qpm > 0,
        instance_id: instanceId,
        model_id: modelId,
        input_tpm: override?.tpm ?? configured.tpm,
        qpm: override?.qpm ?? configured.qpm,
        source: override === null ? "global" : "override",
        global: configured,
      });
    }

    return ok(c, {
      enabled: config.rateLimit.tpm > 0 || config.rateLimit.qpm > 0,
      ...configured,
      window_seconds: 60,
      overrides: await store.listOverrides(),
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

  try {
    const store = getRateLimitStore(config);
    const dimension = readDimension(parsed);
    if (dimension === null) {
      await store.setLimits({ tpm: inputTpm, qpm });
      return ok(c, { tpm: inputTpm, qpm });
    }
    if (dimension instanceof Error) return error(c, 400, dimension.message);

    await store.setOverride(dimension.instanceId, dimension.modelId, { tpm: inputTpm, qpm });
    return ok(c, {
      instance_id: dimension.instanceId,
      model_id: dimension.modelId,
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

  try {
    const store = getRateLimitStore(config);
    const dimension = readDimension(parsed);
    if (dimension === null) {
      await store.deleteLimits();
      return ok(c, { tpm: config.rateLimit.tpm, qpm: config.rateLimit.qpm });
    }
    if (dimension instanceof Error) return error(c, 400, dimension.message);

    await store.deleteOverride(dimension.instanceId, dimension.modelId);
    return ok(c, {
      instance_id: dimension.instanceId,
      model_id: dimension.modelId,
      deleted: true,
    });
  } catch (err) {
    return error(c, 503, err instanceof Error ? err.message : String(err));
  }
}

async function parseBody(c: Context): Promise<RateLimitBody | Response> {
  try {
    return await c.req.json<RateLimitBody>();
  } catch {
    return error(c, 400, "invalid JSON body");
  }
}

function readDimension(
  body: RateLimitBody,
): { instanceId: string; modelId: string } | Error | null {
  const instanceId = typeof body.instance_id === "string" ? body.instance_id.trim() : "";
  const modelId = typeof body.model_id === "string" ? body.model_id.trim() : "";
  if (!instanceId && !modelId) return null;
  if (!instanceId || !modelId) return new Error("instance_id and model_id must be provided together");
  try {
    validateDimension(instanceId, modelId);
    return { instanceId, modelId };
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

function validateDimension(instanceId: string, modelId: string): void {
  assertKeySegment("instance_id", instanceId);
  if (!modelId || modelId.length > 256 || /[\u0000-\u001f]/.test(modelId)) {
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
