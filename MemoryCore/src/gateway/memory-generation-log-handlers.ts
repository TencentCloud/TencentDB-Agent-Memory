import type { ZodError } from "zod";

import { errorEnvelope, successEnvelope } from "./v2-router.js";
import type { ApiResponseEnvelope, V2AuthContext } from "./v2-schemas.js";
import type { IMemoryStore } from "../core/store/types.js";
import type { StorageAdapter } from "../core/storage/adapter.js";
import { MemoryGenerationLogStore } from "../core/memory-generation-log/store.js";
import { memoryGenerationLogGetSchema, memoryGenerationLogListSchema } from "./memory-generation-log-schemas.js";

interface GenerationLogDeps {
  getStore?: () => IMemoryStore | undefined;
  getStorage?: () => StorageAdapter | undefined;
}

function formatZodErr(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ");
}

async function handleList(body: unknown, auth: V2AuthContext, requestId: string, rawDeps: unknown): Promise<ApiResponseEnvelope> {
  const parsed = memoryGenerationLogListSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodErr(parsed.error), requestId);
  const deps = rawDeps as GenerationLogDeps;
  const storage = deps.getStorage?.();
  if (!storage) return errorEnvelope(503, "GENERATION_LOG_STORE_UNAVAILABLE", requestId);
  const now = Date.now();
  const start = parsed.data.start_time ? Date.parse(parsed.data.start_time) : now - 7 * 24 * 60 * 60 * 1000;
  const end = parsed.data.end_time ? Date.parse(parsed.data.end_time) : now;
  try {
    const result = await new MemoryGenerationLogStore(storage, auth.serviceId).list({
      layer: parsed.data.layer,
      status: parsed.data.status,
      startTimeMs: start,
      endTimeMs: end,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
    });
    return successEnvelope(result, requestId);
  } catch {
    return errorEnvelope(400, "INVALID_GENERATION_LOG_CURSOR", requestId);
  }
}

async function handleGet(body: unknown, auth: V2AuthContext, requestId: string, rawDeps: unknown): Promise<ApiResponseEnvelope> {
  const parsed = memoryGenerationLogGetSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodErr(parsed.error), requestId);
  const deps = rawDeps as GenerationLogDeps;
  const storage = deps.getStorage?.();
  const store = deps.getStore?.();
  if (!storage) return errorEnvelope(503, "GENERATION_LOG_STORE_UNAVAILABLE", requestId);
  const logStore = new MemoryGenerationLogStore(storage, auth.serviceId);

  if (parsed.data.log_id) {
    const log = await logStore.getByLogId(parsed.data.log_id);
    return log ? successEnvelope(log, requestId) : errorEnvelope(404, "MEMORY_GENERATION_LOG_NOT_FOUND", requestId);
  }

  if (!store) return errorEnvelope(503, "Store not available", requestId);
  if (!store.getMemoryGenerationRef) return errorEnvelope(503, "Generation reference store not available", requestId);
  const provenance = await store.getMemoryGenerationRef(parsed.data.layer!, parsed.data.memory_id!);
  if (!provenance) return errorEnvelope(404, "MEMORY_GENERATION_LOG_NOT_FOUND", requestId);
  const log = await logStore.getByKey(provenance.generation_log_key);
  if (!log || !log.output_refs.some((ref) => ref.record_id === parsed.data.memory_id)) {
    return errorEnvelope(404, "MEMORY_GENERATION_LOG_NOT_FOUND", requestId);
  }
  return successEnvelope(log, requestId);
}

type RouteHandler = (body: unknown, auth: V2AuthContext, requestId: string, deps: unknown) => Promise<ApiResponseEnvelope>;

export function makeMemoryGenerationLogRouteTable(): Record<string, RouteHandler> {
  return {
    "/v3/memory-generation-log/list": handleList,
    "/v3/memory-generation-log/get": handleGet,
  };
}
