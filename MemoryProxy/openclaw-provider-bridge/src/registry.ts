import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { assertSafeHeaderValue, normalizeAgentIdentity } from "./config.js";
import type { AgentIdentity, AgentIdentityOverride, RegistryState, SessionIdentitySnapshot } from "./types.js";

export interface IdentityRegistryOptions {
  filePath: string; scope: string; configuredAgents: Record<string, AgentIdentity>; maxSessions: number;
}
const registryKey = (agentId: string, sessionId: string) => `${encodeURIComponent(agentId)}::${encodeURIComponent(sessionId)}`;
const newConversationId = () => `oc-${randomUUID()}`;
const nowIso = () => new Date().toISOString();

export class IdentityRegistry {
  private state: RegistryState;
  private operationQueue: Promise<void> = Promise.resolve();
  private loaded = false;
  constructor(private readonly options: IdentityRegistryOptions) { this.state = this.emptyState(); }
  private emptyState(): RegistryState { return { version: 1, scope: this.options.scope, agents: {}, sessions: {} }; }
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = JSON.parse(await readFile(this.options.filePath, "utf8")) as RegistryState;
      if (raw.version !== 1 || raw.scope !== this.options.scope) throw new Error(`registry scope mismatch at ${this.options.filePath}; use a separate stateFile for this proxy/instance`);
      this.state = { version: 1, scope: raw.scope, agents: raw.agents && typeof raw.agents === "object" ? raw.agents : {}, sessions: raw.sessions && typeof raw.sessions === "object" ? raw.sessions : {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = this.emptyState();
    }
    this.loaded = true;
  }
  private async persist(): Promise<void> {
    await mkdir(dirname(this.options.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.options.filePath);
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { await this.ensureLoaded(); return await operation(); } finally { release(); }
  }
  private selectedAgent(agentId: string): AgentIdentity | undefined { return this.state.agents[agentId] ?? this.options.configuredAgents[agentId]; }
  private pruneSessions(): void {
    const overflow = Object.keys(this.state.sessions).length - this.options.maxSessions;
    if (overflow <= 0) return;
    Object.entries(this.state.sessions).sort(([, a], [, b]) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, overflow).forEach(([key]) => delete this.state.sessions[key]);
  }
  async getOrCreateSession(openClawAgentId: string, openClawSessionId: string): Promise<SessionIdentitySnapshot> {
    return this.locked(async () => {
      const key = registryKey(openClawAgentId, openClawSessionId);
      const existing = this.state.sessions[key];
      if (existing) return { ...existing };
      const identity = this.selectedAgent(openClawAgentId);
      if (!identity) throw new Error(`[memory-proxy] OpenClaw agent "${openClawAgentId}" has no Memory identity mapping. Configure agentMappings or run /memory-proxy agent set <teamId> <memoryAgentId>.`);
      const timestamp = nowIso();
      const snapshot: SessionIdentitySnapshot = {
        openClawAgentId, openClawSessionId, ...identity,
        conversationId: assertSafeHeaderValue(openClawSessionId, "sessionId"),
        createdAt: timestamp, updatedAt: timestamp,
      };
      this.state.sessions[key] = snapshot; this.pruneSessions(); await this.persist(); return { ...snapshot };
    });
  }
  async getSession(agentId: string, sessionId: string): Promise<SessionIdentitySnapshot | undefined> { return this.locked(async () => { const v = this.state.sessions[registryKey(agentId, sessionId)]; return v ? { ...v } : undefined; }); }
  async setAgentIdentity(agentId: string, identity: AgentIdentity): Promise<AgentIdentityOverride> { return this.locked(async () => { const v = { ...normalizeAgentIdentity(identity, `agent ${agentId}`), updatedAt: nowIso() }; this.state.agents[agentId] = v; await this.persist(); return { ...v }; }); }
  async clearAgentIdentity(agentId: string): Promise<void> { return this.locked(async () => { delete this.state.agents[agentId]; await this.persist(); }); }
  async getAgentIdentity(agentId: string): Promise<AgentIdentity | undefined> { return this.locked(async () => { const v = this.selectedAgent(agentId); return v ? { ...v } : undefined; }); }
  async setConversationId(agentId: string, sessionId: string, conversationId: string): Promise<SessionIdentitySnapshot> {
    const existing = await this.getOrCreateSession(agentId, sessionId);
    return this.locked(async () => { const key = registryKey(agentId, sessionId); const current = this.state.sessions[key] ?? existing; current.conversationId = assertSafeHeaderValue(conversationId, "conversationId"); current.updatedAt = nowIso(); this.state.sessions[key] = current; this.pruneSessions(); await this.persist(); return { ...current }; });
  }
  async setTaskId(agentId: string, sessionId: string, taskId?: string): Promise<SessionIdentitySnapshot> {
    const existing = await this.getOrCreateSession(agentId, sessionId);
    return this.locked(async () => { const key = registryKey(agentId, sessionId); const current = this.state.sessions[key] ?? existing; if (taskId) current.taskId = assertSafeHeaderValue(taskId, "taskId"); else delete current.taskId; current.conversationId = newConversationId(); current.updatedAt = nowIso(); this.state.sessions[key] = current; await this.persist(); return { ...current }; });
  }
  static createConversationId(): string { return newConversationId(); }
}
