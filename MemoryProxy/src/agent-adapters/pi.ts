/**
 * Pi (earendil-works pi-coding-agent) client adapter.
 *
 * Pi sends OpenAI Chat Completions with plain-string user content and no
 * cache_control markers / fork-sidequery concept — every request is main.
 * Verified via a real Pi subprocess spike (2026-08-21).
 */
import { defaultAdapter } from "./default.js";
import type { AgentAdapter } from "./types.js";

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
