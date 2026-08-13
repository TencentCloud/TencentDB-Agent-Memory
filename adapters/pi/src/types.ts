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
  timeoutMs?: number;
  rejectUnauthorized?: boolean;
  recall?: RecallConfigFile;
}

export interface RecallConfigFile {
  enabled?: boolean;
  l0Limit?: number;
  l1Limit?: number;
  l2Limit?: number;
  maxChars?: number;
}

export interface RecallOptions {
  enabled: boolean;
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
  recall: RecallOptions;
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
