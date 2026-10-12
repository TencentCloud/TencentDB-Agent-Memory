export type MemoryPromptLayer = "l1" | "l2" | "l3";
export type MemoryPromptSource = "agent" | "team" | "instance" | "system";
export type MemoryPromptSettingAction = "apply" | "replace" | "clear";
export type TimeOrder = "asc" | "desc";

export interface MemoryPromptRecord {
  memory_prompt_id: string;
  name: string;
  layer: MemoryPromptLayer;
  prompt: string;
  version: number;
  status: "active" | "deleting";
  created_by?: string;
  updated_by?: string;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface EffectiveMemoryPrompt {
  memory_prompt_id: string;
  prompt: string;
  layer: MemoryPromptLayer;
  source: MemoryPromptSource;
  version: number;
}

export interface MemoryPromptSetting {
  setting_id: string;
  target_type: "instance" | "team" | "agent";
  team_id?: string;
  agent_id?: string;
  layer: MemoryPromptLayer;
  memory_prompt_id: string;
  updated_by?: string;
  updated_at_ms: number;
}

export interface MemoryPromptSettingLog {
  setting_log_id: string;
  target_type: "instance" | "team" | "agent";
  team_id?: string;
  agent_id?: string;
  layer: MemoryPromptLayer;
  action: MemoryPromptSettingAction;
  reason: "explicit" | "prompt_deleted";
  before_memory_prompt_id?: string;
  after_memory_prompt_id?: string;
  operator_id?: string;
  operated_at_ms: number;
}

export interface MemoryPromptCreateRequest {
  name: string;
  layer: MemoryPromptLayer;
  prompt: string;
}
export interface MemoryPromptCreateData {
  memory_prompt_id: string;
  version: number;
  created_at_ms: number;
}

export interface MemoryPromptUpdateRequest {
  memory_prompt_id: string;
  name?: string;
  prompt?: string;
}
export interface MemoryPromptUpdateData {
  memory_prompt_id: string;
  version: number;
  updated_at_ms: number;
}

export interface MemoryPromptDeleteRequest { memory_prompt_ids: string[]; }
export interface MemoryPromptDeleteData {
  deleted_prompt_ids: string[];
  cleared_settings: { instance: number; team: number; agent: number };
}

export interface MemoryPromptListRequest {
  layer?: MemoryPromptLayer;
  limit?: number;
  offset?: number;
  time_order?: TimeOrder;
}
export interface MemoryPromptListData { items: MemoryPromptRecord[]; }

export interface MemoryPromptEffectiveRequest {
  team_id?: string;
  agent_id?: string;
  layer: MemoryPromptLayer;
}

export interface MemoryPromptApplyRequest {
  memory_prompt_id: string;
  layer: MemoryPromptLayer;
  team_id?: string;
  agent_ids?: string[];
}
export interface MemoryPromptClearRequest {
  layer: MemoryPromptLayer;
  team_id?: string;
  agent_ids?: string[];
}
export interface MemoryPromptSetData { affected: number; }

export interface MemoryPromptSettingListRequest {
  memory_prompt_id?: string;
  target_type?: "instance" | "team" | "agent";
  team_id?: string;
  agent_id?: string;
  layer?: MemoryPromptLayer;
  limit?: number;
  offset?: number;
  time_order?: TimeOrder;
}
export interface MemoryPromptSettingListData { items: MemoryPromptSetting[]; }

export interface MemoryPromptSettingLogListRequest {
  memory_prompt_id?: string;
  start_time?: string;
  end_time?: string;
  team_id?: string;
  agent_id?: string;
  action?: MemoryPromptSettingAction;
  limit?: number;
  offset?: number;
  time_order?: TimeOrder;
}
export interface MemoryPromptSettingLogListData { items: MemoryPromptSettingLog[]; }
