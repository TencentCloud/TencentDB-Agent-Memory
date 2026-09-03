import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentIdentity, BridgeModelConfig, BridgePluginConfig } from "./types.js";

const DEFAULT_MODEL: BridgeModelConfig = {
  id: "default", name: "Memory Proxy Default", reasoning: false,
  input: ["text"], contextWindow: 128_000, maxTokens: 8_192,
};

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`[memory-proxy] plugin config ${field} is required`);
  return value.trim();
}

export function assertSafeHeaderValue(value: string, field: string): string {
  if (value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`[memory-proxy] ${field} contains an invalid HTTP header value`);
  }
  return value;
}

export function normalizeAgentIdentity(value: unknown, field: string): AgentIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`[memory-proxy] ${field} must be an object`);
  const record = value as Record<string, unknown>;
  return {
    teamId: assertSafeHeaderValue(requiredString(record.teamId, `${field}.teamId`), `${field}.teamId`),
    memoryAgentId: assertSafeHeaderValue(requiredString(record.memoryAgentId, `${field}.memoryAgentId`), `${field}.memoryAgentId`),
  };
}

export function normalizeConfig(raw: Record<string, unknown> | undefined): BridgePluginConfig {
  const value = raw ?? {};
  const proxyUrl = (typeof value.proxyUrl === "string" && value.proxyUrl.trim() ? value.proxyUrl.trim() : "http://127.0.0.1:8096").replace(/\/+$/, "");
  let parsed: URL;
  try { parsed = new URL(proxyUrl); } catch { throw new Error("[memory-proxy] plugin config proxyUrl must be an absolute http(s) URL"); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("[memory-proxy] plugin config proxyUrl must use http or https");

  const instanceId = assertSafeHeaderValue(
    typeof value.instanceId === "string" && value.instanceId.trim() ? value.instanceId.trim() : "default",
    "instanceId",
  );
  if (value.agentMappings !== undefined && (!value.agentMappings || typeof value.agentMappings !== "object" || Array.isArray(value.agentMappings))) {
    throw new Error("[memory-proxy] plugin config agentMappings must be an object");
  }
  const agentMappings: Record<string, AgentIdentity> = {};
  for (const [agentId, mapping] of Object.entries((value.agentMappings ?? {}) as Record<string, unknown>)) {
    const id = assertSafeHeaderValue(agentId.trim(), "OpenClaw agent id");
    if (id) agentMappings[id] = normalizeAgentIdentity(mapping, `agentMappings.${id}`);
  }
  const models = Array.isArray(value.models) && value.models.length
    ? value.models.map((rawModel, index): BridgeModelConfig => {
        if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) throw new Error(`[memory-proxy] models[${index}] must be an object`);
        const model = rawModel as Record<string, unknown>;
        return {
          id: requiredString(model.id, `models[${index}].id`),
          ...(typeof model.name === "string" && model.name.trim() ? { name: model.name.trim() } : {}),
          reasoning: model.reasoning === true,
          input: Array.isArray(model.input) ? model.input.filter((v): v is "text" | "image" => v === "text" || v === "image") : ["text"],
          contextWindow: typeof model.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : 128_000,
          maxTokens: typeof model.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : 8_192,
        };
      })
    : [DEFAULT_MODEL];
  return {
    proxyUrl, instanceId,
    api: value.api === "anthropic-messages" ? "anthropic-messages" : "openai-completions",
    models, agentMappings,
    ...(typeof value.stateFile === "string" && value.stateFile.trim() ? { stateFile: value.stateFile.trim() } : {}),
    maxSessions: typeof value.maxSessions === "number" && value.maxSessions >= 100 ? Math.floor(value.maxSessions) : 5_000,
  };
}

export function registryScope(config: BridgePluginConfig): string {
  return createHash("sha256").update(`${config.proxyUrl}\n${config.instanceId}`).digest("hex").slice(0, 16);
}

export function resolveStateFile(config: BridgePluginConfig): string {
  if (config.stateFile) {
    const expanded = config.stateFile.startsWith("~/") || config.stateFile.startsWith("~\\") ? join(homedir(), config.stateFile.slice(2)) : config.stateFile;
    return isAbsolute(expanded) ? expanded : resolve(expanded);
  }
  return join(process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".openclaw"), "state", "memory-proxy-bridge", `registry-${registryScope(config)}.json`);
}

export function providerBaseUrl(config: BridgePluginConfig): string {
  return `${config.proxyUrl}/openclaw/${encodeURIComponent(config.instanceId)}/v1`;
}
