/**
 * Pi (earendil-works pi-coding-agent) client adapter.
 *
 * Pi sends OpenAI Chat Completions with plain-string user content and no
 * cache_control markers / fork-sidequery concept — every request is main.
 * Verified via a real Pi subprocess spike (2026-08-21).
 */
import { defaultAdapter } from "./default.js";
import type { AgentAdapter } from "./types.js";
import type { ProxyConfig } from "../types.js";
import { buildTdaiClientForRequest } from "../tdai/client.js";
import { createPiConversationWrite } from "./pi-outbox-runtime.js";

/** One server-side recording operation per model response, scoped by request trace. */
export function buildPiTdaiClient(config: ProxyConfig, spaceId: string | undefined, turnKey: string) {
  const t = config.tdai;
  const write = t.piOutbox?.enabled && t.enabled && t.memory.enabled && t.memory.writeL0
    ? createPiConversationWrite(t, spaceId || t.serviceId, turnKey) : undefined;
  return buildTdaiClientForRequest(config, spaceId, write);
}

export const piAdapter: AgentAdapter = {
  agentKind: "pi",
  classifyRequest() {
    return "main";
  },
  extractUserText(content) {
    if (typeof content === "string") return content.length > 0 ? content : null;
    return defaultAdapter.extractUserText(content);
  },
};
