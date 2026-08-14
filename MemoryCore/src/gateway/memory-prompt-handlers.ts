import { randomUUID } from "node:crypto";
import type { ZodError } from "zod";

import { errorEnvelope, successEnvelope } from "./v2-router.js";
import type { ApiResponseEnvelope, V2AuthContext } from "./v2-schemas.js";
import type { IMemoryStore } from "../core/store/types.js";
import {
  buildMemoryPromptSettingId,
  getMemoryPromptTargetType,
  type MemoryPromptLayer,
  type MemoryPromptSettingLogRecord,
  type MemoryPromptSettingRecord,
} from "../core/memory-prompt/types.js";
import { resolveMemoryPrompt } from "../core/memory-prompt/resolver.js";
import {
  memoryPromptCreateSchema,
  memoryPromptDeleteSchema,
  memoryPromptGetSchema,
  memoryPromptLogSchema,
  memoryPromptSettingListSchema,
  memoryPromptSetSchema,
  memoryPromptUpdateSchema,
} from "./memory-prompt-schemas.js";

function formatZodErr(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ");
}

type PromptDeps = {
  getStore?: () => IMemoryStore | undefined;
  requestIsolation?: { userId?: string };
};

function getDeps(deps: unknown): PromptDeps {
  return deps as PromptDeps;
}

function getStore(deps: unknown): IMemoryStore | undefined {
  return getDeps(deps).getStore?.();
}

function operatorId(deps: unknown): string | undefined {
  return getDeps(deps).requestIsolation?.userId;
}

function missingStore(requestId: string): ApiResponseEnvelope {
  return errorEnvelope(503, "Memory prompt store not available", requestId);
}

function unsupportedStore(requestId: string): ApiResponseEnvelope {
  return errorEnvelope(503, "Memory prompt store does not support this operation", requestId);
}

async function handleCreate(body: unknown, _auth: V2AuthContext, requestId: string, deps: unknown): Promise<ApiResponseEnvelope> {
  const parsed = memoryPromptCreateSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodErr(parsed.error), requestId);
  const store = getStore(deps);
  if (!store) return missingStore(requestId);
  if (!store.countMemoryPrompts || !store.createMemoryPrompt) return unsupportedStore(requestId);
  const count = await store.countMemoryPrompts();
  if (count >= 500) return errorEnvelope(409, "PROMPT_LIMIT_EXCEEDED: maximum 500 prompts per instance", requestId);
  const now = Date.now();
  const id = `mp-${randomUUID()}`;
  const record = await store.createMemoryPrompt({
    memory_prompt_id: id,
    name: parsed.data.name,
    layer: parsed.data.layer,
    prompt: parsed.data.prompt,
    version: 1,
    status: "active",
    created_by: operatorId(deps),
    updated_by: operatorId(deps),
    created_at_ms: now,
    updated_at_ms: now,
  });
  return successEnvelope({
    memory_prompt_id: record.memory_prompt_id,
    version: record.version,
    created_at_ms: record.created_at_ms,
  }, requestId);
}

async function handleGet(body: unknown, _auth: V2AuthContext, requestId: string, deps: unknown): Promise<ApiResponseEnvelope> {
  const parsed = memoryPromptGetSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodErr(parsed.error), requestId);
  const store = getStore(deps);
  if (!store) return missingStore(requestId);
  const data = parsed.data;
  if (data.memory_prompt_id) {
    if (!store.getMemoryPrompts) return unsupportedStore(requestId);
    const record = (await store.getMemoryPrompts([data.memory_prompt_id]))[0];
    return record && record.status === "active"
      ? successEnvelope(record, requestId)
      : errorEnvelope(404, "MEMORY_PROMPT_NOT_FOUND", requestId);
  }
  if (data.layer && (data.team_id || data.agent_id)) {
    const resolved = await resolveMemoryPrompt(store, {
      teamId: data.team_id,
      agentId: data.agent_id,
      layer: data.layer,
    });
    return successEnvelope(resolved ?? {
      memory_prompt_id: `builtin:${data.layer}`,
      prompt: "",
      layer: data.layer,
      source: "system",
      version: 1,
    }, requestId);
  }
  if (!store.listMemoryPrompts) return unsupportedStore(requestId);
  return successEnvelope({
    items: await store.listMemoryPrompts({
      layer: data.layer,
      limit: data.limit,
      offset: data.offset,
      timeOrder: data.time_order,
    }),
  }, requestId);
}

async function handleUpdate(body: unknown, _auth: V2AuthContext, requestId: string, deps: unknown): Promise<ApiResponseEnvelope> {
  const parsed = memoryPromptUpdateSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodErr(parsed.error), requestId);
  const store = getStore(deps);
  if (!store) return missingStore(requestId);
  if (!store.updateMemoryPrompt) return unsupportedStore(requestId);
  const record = await store.updateMemoryPrompt(parsed.data.memory_prompt_id, {
    name: parsed.data.name,
    prompt: parsed.data.prompt,
    updated_by: operatorId(deps),
    updated_at_ms: Date.now(),
  });
  return record
    ? successEnvelope({ memory_prompt_id: record.memory_prompt_id, version: record.version, updated_at_ms: record.updated_at_ms }, requestId)
    : errorEnvelope(404, "MEMORY_PROMPT_NOT_FOUND", requestId);
}

async function handleDelete(body: unknown, _auth: V2AuthContext, requestId: string, deps: unknown): Promise<ApiResponseEnvelope> {
  const parsed = memoryPromptDeleteSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodErr(parsed.error), requestId);
  const store = getStore(deps);
  if (!store) return missingStore(requestId);
  if (!store.getMemoryPrompts || !store.deleteMemoryPrompts) return unsupportedStore(requestId);
  const records = await store.getMemoryPrompts(parsed.data.memory_prompt_ids);
  if (records.length !== parsed.data.memory_prompt_ids.length) {
    return errorEnvelope(404, "MEMORY_PROMPT_NOT_FOUND: batch delete requires every id to exist", requestId);
  }
  return successEnvelope(
    await store.deleteMemoryPrompts(parsed.data.memory_prompt_ids, operatorId(deps)),
    requestId,
  );
}

function targetsOf(data: { team_id?: string; agent_ids?: string[] }): Array<{ teamId?: string; agentId?: string }> {
  if (data.agent_ids) return data.agent_ids.map((agentId) => ({ teamId: data.team_id, agentId }));
  if (data.team_id) return [{ teamId: data.team_id }];
  return [{}];
}

async function handleSet(body: unknown, _auth: V2AuthContext, requestId: string, deps: unknown): Promise<ApiResponseEnvelope> {
  const parsed = memoryPromptSetSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodErr(parsed.error), requestId);
  const store = getStore(deps);
  if (!store) return missingStore(requestId);
  if (!store.getMemoryPromptSettings || !store.upsertMemoryPromptSettings || !store.clearMemoryPromptSettings) {
    return unsupportedStore(requestId);
  }
  const data = parsed.data;
  let promptId: string | undefined;
  if (data.action === "apply") {
    if (!store.getMemoryPrompts) return unsupportedStore(requestId);
    const prompt = (await store.getMemoryPrompts([data.memory_prompt_id!]))[0];
    if (!prompt || prompt.status !== "active") return errorEnvelope(404, "MEMORY_PROMPT_NOT_FOUND", requestId);
    if (prompt.layer !== data.layer) return errorEnvelope(400, "PROMPT_LAYER_MISMATCH", requestId);
    promptId = prompt.memory_prompt_id;
  }

  const targets = targetsOf(data);
  const ids = targets.map((target) => buildMemoryPromptSettingId(target, data.layer));
  const current = await store.getMemoryPromptSettings(ids);
  const currentById = new Map(current.map((setting) => [setting.setting_id, setting]));
  const now = Date.now();
  const operator = operatorId(deps);
  const logs: MemoryPromptSettingLogRecord[] = [];

  if (data.action === "clear") {
    const clearIds: string[] = [];
    for (let index = 0; index < targets.length; index += 1) {
      const old = currentById.get(ids[index]);
      if (!old) continue;
      clearIds.push(ids[index]);
      logs.push({
        setting_log_id: `mpsl-${randomUUID()}`,
        target_type: old.target_type,
        team_id: old.team_id,
        agent_id: old.agent_id,
        layer: old.layer,
        action: "clear",
        reason: "explicit",
        before_memory_prompt_id: old.memory_prompt_id,
        operator_id: operator,
        operated_at_ms: now,
      });
    }
    await store.clearMemoryPromptSettings(clearIds, logs);
    return successEnvelope({ affected: clearIds.length }, requestId);
  }

  const records: MemoryPromptSettingRecord[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const old = currentById.get(ids[index]);
    if (old?.memory_prompt_id === promptId) continue;
    records.push({
      setting_id: ids[index],
      target_type: getMemoryPromptTargetType(target),
      team_id: target.teamId,
      agent_id: target.agentId,
      layer: data.layer,
      memory_prompt_id: promptId!,
      updated_by: operator,
      updated_at_ms: now,
    });
    logs.push({
      setting_log_id: `mpsl-${randomUUID()}`,
      target_type: getMemoryPromptTargetType(target),
      team_id: target.teamId,
      agent_id: target.agentId,
      layer: data.layer,
      action: old ? "replace" : "apply",
      reason: "explicit",
      before_memory_prompt_id: old?.memory_prompt_id,
      after_memory_prompt_id: promptId,
      operator_id: operator,
      operated_at_ms: now,
    });
  }
  await store.upsertMemoryPromptSettings(records, logs);
  return successEnvelope({ affected: records.length }, requestId);
}

async function handleSettingList(body: unknown, _auth: V2AuthContext, requestId: string, deps: unknown): Promise<ApiResponseEnvelope> {
  const parsed = memoryPromptSettingListSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodErr(parsed.error), requestId);
  const store = getStore(deps);
  if (!store) return missingStore(requestId);
  if (!store.listMemoryPromptSettings) return unsupportedStore(requestId);
  return successEnvelope({
    items: await store.listMemoryPromptSettings({
      memoryPromptId: parsed.data.memory_prompt_id,
      targetType: parsed.data.target_type,
      teamId: parsed.data.team_id,
      agentId: parsed.data.agent_id,
      layer: parsed.data.layer,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
      timeOrder: parsed.data.time_order,
    }),
  }, requestId);
}

async function handleLog(body: unknown, _auth: V2AuthContext, requestId: string, deps: unknown): Promise<ApiResponseEnvelope> {
  const parsed = memoryPromptLogSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodErr(parsed.error), requestId);
  const store = getStore(deps);
  if (!store) return missingStore(requestId);
  if (!store.queryMemoryPromptSettingLogs) return unsupportedStore(requestId);
  const now = Date.now();
  const start = parsed.data.start_time ? Date.parse(parsed.data.start_time) : now - 7 * 24 * 60 * 60 * 1000;
  const end = parsed.data.end_time ? Date.parse(parsed.data.end_time) : now;
  return successEnvelope({
    items: await store.queryMemoryPromptSettingLogs({
      memoryPromptId: parsed.data.memory_prompt_id,
      teamId: parsed.data.team_id,
      agentId: parsed.data.agent_id,
      action: parsed.data.action,
      startTimeMs: start,
      endTimeMs: end,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
      timeOrder: parsed.data.time_order,
    }),
  }, requestId);
}

type RouteHandler = (body: unknown, auth: V2AuthContext, requestId: string, deps: unknown) => Promise<ApiResponseEnvelope>;

export function makeMemoryPromptRouteTable(): Record<string, RouteHandler> {
  return {
    "/v3/memory-prompt/create": handleCreate,
    "/v3/memory-prompt/get": handleGet,
    "/v3/memory-prompt/update": handleUpdate,
    "/v3/memory-prompt/delete": handleDelete,
    "/v3/memory-prompt/set": handleSet,
    "/v3/memory-prompt/setting/list": handleSettingList,
    "/v3/memory-prompt/log": handleLog,
  };
}
