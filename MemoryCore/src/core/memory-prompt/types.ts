import { createHash } from "node:crypto";

export type MemoryPromptLayer = "l1" | "l2" | "l3";
export type MemoryPromptSource = "agent" | "team" | "instance" | "system";
export type MemoryPromptTargetType = "instance" | "team" | "agent";
export type MemoryPromptSettingAction = "apply" | "replace" | "clear";

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

export interface MemoryPromptSettingRecord {
  setting_id: string;
  target_type: MemoryPromptTargetType;
  team_id?: string;
  agent_id?: string;
  layer: MemoryPromptLayer;
  memory_prompt_id: string;
  updated_by?: string;
  updated_at_ms: number;
}

export interface MemoryPromptDeleteResult {
  deleted_prompt_ids: string[];
  cleared_settings: Record<MemoryPromptTargetType, number>;
}

export interface MemoryPromptSettingLogRecord {
  setting_log_id: string;
  target_type: MemoryPromptTargetType;
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

export interface MemoryPromptListFilter {
  layer?: MemoryPromptLayer;
  limit?: number;
  offset?: number;
  timeOrder?: "asc" | "desc";
}

export interface MemoryPromptSettingListFilter {
  memoryPromptId?: string;
  targetType?: MemoryPromptTargetType;
  teamId?: string;
  agentId?: string;
  layer?: MemoryPromptLayer;
  limit?: number;
  offset?: number;
  timeOrder?: "asc" | "desc";
}

export interface MemoryPromptSettingLogFilter {
  memoryPromptId?: string;
  teamId?: string;
  agentId?: string;
  action?: MemoryPromptSettingAction;
  startTimeMs?: number;
  endTimeMs?: number;
  limit?: number;
  offset?: number;
  timeOrder?: "asc" | "desc";
}

export interface ResolvedMemoryPrompt {
  memory_prompt_id: string;
  prompt: string;
  layer: MemoryPromptLayer;
  source: MemoryPromptSource;
  version: number;
}

export interface MemoryPromptStore {
  countMemoryPrompts?(): Promise<number> | number;
  createMemoryPrompt?(record: MemoryPromptRecord): Promise<MemoryPromptRecord> | MemoryPromptRecord;
  getMemoryPrompts?(ids: string[]): Promise<MemoryPromptRecord[]> | MemoryPromptRecord[];
  listMemoryPrompts?(filter: MemoryPromptListFilter): Promise<MemoryPromptRecord[]> | MemoryPromptRecord[];
  updateMemoryPrompt?(
    id: string,
    patch: { name?: string; prompt?: string; updated_by?: string; updated_at_ms: number },
  ): Promise<MemoryPromptRecord | null> | MemoryPromptRecord | null;
  deleteMemoryPrompts?(
    ids: string[],
    operatorId?: string,
  ): Promise<MemoryPromptDeleteResult> | MemoryPromptDeleteResult;
  getMemoryPromptSettings?(ids: string[]): Promise<MemoryPromptSettingRecord[]> | MemoryPromptSettingRecord[];
  listMemoryPromptSettings?(
    filter: MemoryPromptSettingListFilter,
  ): Promise<MemoryPromptSettingRecord[]> | MemoryPromptSettingRecord[];
  upsertMemoryPromptSettings?(
    records: MemoryPromptSettingRecord[],
    logs: MemoryPromptSettingLogRecord[],
  ): Promise<void> | void;
  clearMemoryPromptSettings?(
    ids: string[],
    logs: MemoryPromptSettingLogRecord[],
  ): Promise<void> | void;
  queryMemoryPromptSettingLogs?(
    filter: MemoryPromptSettingLogFilter,
  ): Promise<MemoryPromptSettingLogRecord[]> | MemoryPromptSettingLogRecord[];
}

function targetHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function buildMemoryPromptSettingId(
  target: { teamId?: string; agentId?: string },
  layer: MemoryPromptLayer,
): string {
  if (target.agentId) {
    if (!target.teamId) throw new Error("teamId is required for an agent prompt setting");
    return `mps:a:${targetHash(`${target.teamId}\0${target.agentId}`)}:${layer}`;
  }
  if (target.teamId) return `mps:t:${targetHash(target.teamId)}:${layer}`;
  return `mps:i:${layer}`;
}

export function getMemoryPromptTargetType(target: {
  teamId?: string;
  agentId?: string;
}): MemoryPromptTargetType {
  if (target.agentId) return "agent";
  if (target.teamId) return "team";
  return "instance";
}
