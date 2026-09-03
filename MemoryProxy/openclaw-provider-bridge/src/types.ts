export interface AgentIdentity {
  teamId: string;
  memoryAgentId: string;
}

export interface BridgeModelConfig {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
}

export interface BridgePluginConfig {
  proxyUrl: string;
  instanceId: string;
  api?: "openai-completions" | "anthropic-messages";
  models?: BridgeModelConfig[];
  agentMappings: Record<string, AgentIdentity>;
  stateFile?: string;
  maxSessions?: number;
}

export interface SessionIdentitySnapshot extends AgentIdentity {
  openClawAgentId: string;
  openClawSessionId: string;
  conversationId: string;
  taskId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentIdentityOverride extends AgentIdentity { updatedAt: string }
export interface RegistryState {
  version: 1;
  scope: string;
  agents: Record<string, AgentIdentityOverride>;
  sessions: Record<string, SessionIdentitySnapshot>;
}
