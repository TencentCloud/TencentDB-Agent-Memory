/**
 * Dify adapter — OpenAPI spec generator for the /tools/* endpoints.
 *
 * Dify's "Custom Tool" feature imports an OpenAPI (3.x) document and turns
 * each operation into an agent-callable tool. The adapter serves this spec at
 * `GET /openapi.json`, so wiring the memory WRITE path into a Dify app is:
 * paste the URL → import → done.
 *
 * Only the two tool operations are described here — `/retrieval` is NOT a
 * tool (Dify calls it internally through the External Knowledge Base
 * mechanism) and `/health` is operational.
 */

export function buildOpenApiSpec(baseUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "TDAI Memory Tools",
      description:
        "Long-term memory tools backed by TencentDB-Agent-Memory. " +
        "`memory_capture` saves a conversation turn; `memory_recall` retrieves relevant memory context.",
      version: "1.0.0",
    },
    servers: [{ url: baseUrl }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/tools/capture": {
        post: {
          operationId: "memory_capture",
          summary: "Save one conversation turn into long-term memory",
          description:
            "Records the user message and assistant reply as a completed turn. The memory engine " +
            "archives the raw exchange (L0) and asynchronously extracts structured memories (L1/L2/L3).",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    user_content: {
                      type: "string",
                      description: "The user's message text for the turn",
                    },
                    assistant_content: {
                      type: "string",
                      description: "The assistant's reply text for the turn",
                    },
                    session_key: {
                      type: "string",
                      description: "Optional session key (defaults to the adapter's configured session)",
                    },
                    session_id: {
                      type: "string",
                      description: "Optional sub-session identifier",
                    },
                  },
                  required: ["user_content", "assistant_content"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Capture accepted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      l0_recorded: { type: "integer", description: "Messages archived" },
                      scheduler_notified: { type: "boolean", description: "Extraction pipeline notified" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/tools/recall": {
        post: {
          operationId: "memory_recall",
          summary: "Retrieve memory context relevant to a query",
          description:
            "Returns persona/scene/memory context assembled by the memory engine for the given query. " +
            "Use at the start of a conversation turn to load what is already known about the user.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    query: {
                      type: "string",
                      description: "The user's current question or topic",
                    },
                    session_key: {
                      type: "string",
                      description: "Optional session key (defaults to the adapter's configured session)",
                    },
                  },
                  required: ["query"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Recall result",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      context: { type: "string", description: "Memory context text ('' when nothing recalled)" },
                      strategy: { type: "string", description: "Search strategy used" },
                      memory_count: { type: "integer", description: "Number of memories recalled" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Set to the adapter's TDAI_DIFY_API_KEY value",
        },
      },
    },
  };
}
