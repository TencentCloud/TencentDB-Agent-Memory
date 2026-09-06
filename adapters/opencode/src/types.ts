export type JsonRecord = Record<string, unknown>;

export interface OpenCodeMessage {
  info: JsonRecord;
  parts: JsonRecord[];
}

export type SkillRole = "user" | "assistant" | "tool_call" | "tool_result";

export interface SkillMessage {
  role: SkillRole;
  content: string;
  tool_name?: string;
  tool_call_id?: string;
  timestamp?: number | string;
}

export interface CapturedTurn {
  key: string;
  sessionId: string;
  sourceId: string;
  user: string;
  assistant: string;
  capturedAtMs: number;
  skillMessages: SkillMessage[];
}

export interface DeliveryState {
  l0: boolean;
  skill: boolean;
}

export interface PendingDelivery extends DeliveryState {
  version: 1;
  key: string;
  createdAtMs: number;
  turn?: CapturedTurn;
}

export interface RecallBundle {
  conversations: Array<{ id?: string; role?: string; content: string; timestamp?: string; score?: number }>;
  atomic: Array<{ id?: string; type?: string; content: string; background?: string; score?: number }>;
  core: string | null;
  skills: string | null;
  warnings: string[];
}
