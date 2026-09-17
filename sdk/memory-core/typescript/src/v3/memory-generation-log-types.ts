import type { MemoryPromptLayer, MemoryPromptSource } from "./memory-prompt-types.js";

export type MemoryGenerationStatus = "succeeded" | "failed";

export interface MemoryGenerationRef {
  layer: "l0" | MemoryPromptLayer;
  record_id: string;
}

export interface MemoryGenerationLog {
  schema_version: 1;
  log_id: string;
  generation_id: string;
  instance_id: string;
  layer: MemoryPromptLayer;
  status: MemoryGenerationStatus;
  team_id?: string;
  agent_id?: string;
  user_id?: string;
  session_id?: string;
  task_id?: string;
  prompt: {
    memory_prompt_id: string;
    version: number;
    source: MemoryPromptSource;
    prompt_sha256: string;
  };
  anchor_memory_id?: string;
  input_refs: MemoryGenerationRef[];
  output_refs: MemoryGenerationRef[];
  model?: string;
  prompt_mode?: string;
  started_at_ms: number;
  finished_at_ms: number;
  latency_ms: number;
  error_code?: string;
  error_message?: string;
}

export interface MemoryGenerationLogListRequest {
  layer?: MemoryPromptLayer;
  status?: MemoryGenerationStatus;
  start_time?: string;
  end_time?: string;
  limit?: number;
  cursor?: string;
}
export interface MemoryGenerationLogListItem {
  log_id: string;
  layer: MemoryPromptLayer;
  status: MemoryGenerationStatus;
  anchor_memory_id?: string;
  finished_at_ms: number;
  size: number;
  key: string;
}
export interface MemoryGenerationLogListData {
  items: MemoryGenerationLogListItem[];
  next_cursor?: string;
}

export type MemoryGenerationLogGetRequest =
  | { log_id: string; memory_id?: never; layer?: never }
  | { memory_id: string; layer: MemoryPromptLayer; log_id?: never };
