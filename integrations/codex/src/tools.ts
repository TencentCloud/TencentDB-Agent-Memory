export const TOOL_DEFINITIONS = [
  {
    name: "agent_memory_health",
    description: "Check whether the TencentDB Agent Memory Gateway and its stores are available.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "agent_memory_recall",
    description: "Recall relevant long-term memory before a Codex task when prior preferences, context, or decisions may matter.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Current task or question used for recall." },
        session_key: { type: "string" },
        user_id: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "agent_memory_capture",
    description: "Capture a meaningful completed Codex task, turn, decision, or milestone into Agent Memory.",
    inputSchema: {
      type: "object",
      properties: {
        user_content: { type: "string", description: "User request or concise task description." },
        assistant_content: { type: "string", description: "Outcome, decisions, files changed, and unresolved follow-ups. Do not repeat recalled context verbatim." },
        session_key: { type: "string" },
        session_id: { type: "string" },
        user_id: { type: "string" },
        messages: { type: "array", items: { type: "object" } },
      },
      required: ["user_content", "assistant_content"],
      additionalProperties: false,
    },
  },
  {
    name: "agent_memory_search",
    description: "Search L1 structured long-term memories for specific historical facts or decisions.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        type: { type: "string" },
        scene: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "agent_conversation_search",
    description: "Search L0 raw conversation evidence when exact previous wording or turn history is needed.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        session_key: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "agent_memory_session_end",
    description: "Flush pending memory work when a Codex thread or task session ends.",
    inputSchema: {
      type: "object",
      properties: { session_key: { type: "string" }, user_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "agent_memory_seed",
    description: "Import historical Codex conversations or prepared session data through the Gateway seed pipeline.",
    inputSchema: {
      type: "object",
      properties: {
        data: {},
        session_key: { type: "string" },
        strict_round_role: { type: "boolean" },
        auto_fill_timestamps: { type: "boolean" },
        config_override: { type: "object" },
      },
      required: ["data"],
      additionalProperties: false,
    },
  },
] as const;

export type ToolName = (typeof TOOL_DEFINITIONS)[number]["name"];
