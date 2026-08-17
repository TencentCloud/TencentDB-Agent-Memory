export interface AdapterConfigFile {
  schemaVersion?: number;
  enabled?: boolean;
  endpoint?: string;
  serviceId?: string;
  teamId?: string;
  agentId?: string;
  userId?: string;
  userKeyFile?: string;
  gatewayApiKeyFile?: string;
  /** Global-only opt-in for the constrained project recall override. */
  allowProjectConfig?: boolean;
  timeoutMs?: number;
  rejectUnauthorized?: boolean;
  captureTools?: boolean;
  recall?: RecallConfigFile;
  skills?: SkillsConfigFile;
}

export interface RecallConfigFile {
  enabled?: boolean;
  deadlineMs?: number;
  l0Limit?: number;
  l1Limit?: number;
  l2Limit?: number;
  maxChars?: number;
}

export interface SkillsConfigFile {
  enabled?: boolean;
  capture?: boolean;
  runtimeTools?: boolean;
  routingMode?: "bm25" | "embedding" | "hybrid";
  allowTeamSearch?: boolean;
  includeFailedTools?: boolean;
  maxMessageBytes?: number;
  maxToolItems?: number;
  flushTimeoutMs?: number;
}

export interface SkillsOptions {
  enabled: boolean;
  capture: boolean;
  runtimeTools: boolean;
  routingMode: "bm25" | "embedding" | "hybrid";
  allowTeamSearch: boolean;
  includeFailedTools: boolean;
  maxMessageBytes: number;
  maxToolItems: number;
  flushTimeoutMs: number;
}

export interface RecallOptions {
  enabled: boolean;
  deadlineMs: number;
  l0Limit: number;
  l1Limit: number;
  l2Limit: number;
  maxChars: number;
}

export interface LoadedConfig {
  enabled: true;
  endpoint: string;
  serviceId: string;
  teamId: string;
  agentId: string;
  userId: string;
  userKey: string;
  gatewayApiKey: string;
  timeoutMs: number;
  rejectUnauthorized: boolean;
  captureTools: boolean;
  recall: RecallOptions;
  skills: SkillsOptions;
  sources: string[];
  userKeySource: string;
  gatewayApiKeySource: string;
}

export interface DisabledConfig {
  enabled: false;
  sources: string[];
}

export type AdapterConfig = LoadedConfig | DisabledConfig;

export type ConfigResult =
  | { ok: true; config: AdapterConfig }
  | { ok: false; errors: string[]; sources: string[] };

export type StatusKind = "ready" | "disabled" | "config-error" | "auth-error" | "offline" | "error";

export interface AdapterStatus {
  kind: StatusKind;
  summary: string;
  details: string[];
}
