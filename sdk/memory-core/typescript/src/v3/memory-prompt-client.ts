import { ParamError } from "../errors.js";
import type { MemoryClientConfig, Transport } from "../client.js";
import { V3HttpTransport } from "./http.js";
import type {
  EffectiveMemoryPrompt,
  MemoryPromptApplyRequest,
  MemoryPromptClearRequest,
  MemoryPromptCreateData,
  MemoryPromptCreateRequest,
  MemoryPromptDeleteData,
  MemoryPromptDeleteRequest,
  MemoryPromptEffectiveRequest,
  MemoryPromptListData,
  MemoryPromptListRequest,
  MemoryPromptRecord,
  MemoryPromptSetData,
  MemoryPromptSettingListData,
  MemoryPromptSettingListRequest,
  MemoryPromptSettingLogListData,
  MemoryPromptSettingLogListRequest,
  MemoryPromptUpdateData,
  MemoryPromptUpdateRequest,
} from "./memory-prompt-types.js";

const ROOT = "/v3/memory-prompt";

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
function requireText(name: string, value: string | undefined): string {
  if (!value?.trim()) throw new ParamError(`${name} must be a non-empty string`);
  return value;
}
function requireTarget(teamId?: string, agentIds?: string[]): void {
  if (agentIds && !teamId) throw new ParamError("team_id is required with agent_ids");
  if (agentIds && (agentIds.length === 0 || agentIds.some((id) => !id.trim()))) {
    throw new ParamError("agent_ids must be a non-empty list of non-empty strings");
  }
}

export interface MemoryPromptClientConfig extends MemoryClientConfig {
  teamId?: string;
  agentId?: string;
}

export class MemoryPromptClient {
  private readonly http: Transport;
  private readonly defaults: { teamId?: string; agentId?: string };

  constructor(config: MemoryPromptClientConfig);
  constructor(transport: Transport, defaults?: { teamId?: string; agentId?: string });
  constructor(configOrTransport: MemoryPromptClientConfig | Transport, defaults = {}) {
    if ("post" in configOrTransport) {
      this.http = configOrTransport;
      this.defaults = defaults;
    } else {
      this.http = new V3HttpTransport(Object.fromEntries([
        ["endpoint", configOrTransport.endpoint],
        ["apiKey", configOrTransport.apiKey],
        ["serviceId", configOrTransport.serviceId],
        ["timeout", configOrTransport.timeout],
        ["rejectUnauthorized", configOrTransport.rejectUnauthorized],
      ]) as MemoryClientConfig);
      this.defaults = { teamId: configOrTransport.teamId, agentId: configOrTransport.agentId };
    }
  }

  private requestGet<T>(path: string, query: Record<string, unknown>): Promise<T> {
    return this.http.get ? this.http.get<T>(path, query) : this.http.post<T>(path, query);
  }

  create(params: MemoryPromptCreateRequest): Promise<MemoryPromptCreateData> {
    requireText("name", params.name);
    requireText("prompt", params.prompt);
    return this.http.post(`${ROOT}/create`, { ...params });
  }

  get(memoryPromptId: string): Promise<MemoryPromptRecord> {
    return this.requestGet(`${ROOT}/get`, { memory_prompt_id: requireText("memory_prompt_id", memoryPromptId) });
  }

  list(params: MemoryPromptListRequest = {}): Promise<MemoryPromptListData> {
    return this.requestGet(`${ROOT}/get`, stripUndefined({ ...params }));
  }

  getEffective(params: MemoryPromptEffectiveRequest): Promise<EffectiveMemoryPrompt> {
    const teamId = params.team_id ?? this.defaults.teamId;
    const agentId = params.agent_id ?? this.defaults.agentId;
    if (!teamId) throw new ParamError("team_id is required for effective prompt lookup");
    return this.requestGet(`${ROOT}/get`, stripUndefined({ team_id: teamId, agent_id: agentId, layer: params.layer }));
  }

  update(params: MemoryPromptUpdateRequest): Promise<MemoryPromptUpdateData> {
    requireText("memory_prompt_id", params.memory_prompt_id);
    if (params.name === undefined && params.prompt === undefined) throw new ParamError("name or prompt is required");
    return this.http.post(`${ROOT}/update`, stripUndefined({ ...params }));
  }

  delete(params: MemoryPromptDeleteRequest): Promise<MemoryPromptDeleteData> {
    if (!params.memory_prompt_ids.length || params.memory_prompt_ids.some((id) => !id.trim())) {
      throw new ParamError("memory_prompt_ids must be a non-empty list of non-empty strings");
    }
    return this.http.post(`${ROOT}/delete`, { memory_prompt_ids: [...new Set(params.memory_prompt_ids)] });
  }

  apply(params: MemoryPromptApplyRequest): Promise<MemoryPromptSetData> {
    const teamId = params.team_id ?? this.defaults.teamId;
    requireTarget(teamId, params.agent_ids);
    return this.http.post(`${ROOT}/set`, stripUndefined({
      action: "apply",
      memory_prompt_id: requireText("memory_prompt_id", params.memory_prompt_id),
      team_id: teamId,
      agent_ids: params.agent_ids,
      layer: params.layer,
    }));
  }

  clear(params: MemoryPromptClearRequest): Promise<MemoryPromptSetData> {
    const teamId = params.team_id ?? this.defaults.teamId;
    requireTarget(teamId, params.agent_ids);
    return this.http.post(`${ROOT}/set`, stripUndefined({
      action: "clear",
      team_id: teamId,
      agent_ids: params.agent_ids,
      layer: params.layer,
    }));
  }

  listSettings(params: MemoryPromptSettingListRequest = {}): Promise<MemoryPromptSettingListData> {
    const teamId = params.team_id ?? this.defaults.teamId;
    const agentId = params.agent_id ?? this.defaults.agentId;
    if (agentId && !teamId) throw new ParamError("team_id is required with agent_id");
    if (params.target_type === "instance" && (teamId || agentId)) {
      throw new ParamError("instance target cannot include team_id or agent_id");
    }
    if (params.target_type === "team" && agentId) {
      throw new ParamError("team target cannot include agent_id");
    }
    return this.requestGet(`${ROOT}/setting/list`, stripUndefined({ ...params, team_id: teamId, agent_id: agentId }));
  }

  listSettingLogs(params: MemoryPromptSettingLogListRequest): Promise<MemoryPromptSettingLogListData> {
    const teamId = params.team_id ?? this.defaults.teamId;
    const agentId = params.agent_id ?? this.defaults.agentId;
    if (agentId && !teamId) throw new ParamError("team_id is required with agent_id");
    if (!params.memory_prompt_id && !teamId && !agentId) {
      throw new ParamError("memory_prompt_id or a target condition is required");
    }
    return this.requestGet(`${ROOT}/log`, stripUndefined({ ...params, team_id: teamId, agent_id: agentId }));
  }
}
