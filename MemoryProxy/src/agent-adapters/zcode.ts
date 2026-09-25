import { extractLastUserText } from "../common/user-text-extractor.js";
import type { AgentAdapter } from "./types.js";

export const zcodeAdapter: AgentAdapter = {
  agentKind: "zcode",
  // ponytail: only main requests captured; classify other session types when verified.
  classifyRequest: () => "main",
  // Anthropic: skip leading reminders. OpenAI: accept the plain string.
  extractUserText: (content) => extractLastUserText(content) || null,
};
