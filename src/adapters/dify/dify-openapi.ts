/**
 * Dify OpenAPI 3.0 规范生成器。
 *
 * 生成 OpenAPI 规范文档，用户可在 Dify 中导入此文档
 * 作为自定义工具。每个 TDAI 记忆 API 映射为一个 Dify 工具。
 *
 * Dify 工具导入文档格式：
 * - GET /openapi.json: OpenAPI 3.0.1 规范
 */

/**
 * 生成 Dify 可导入的 OpenAPI 3.0 规范。
 *
 * @param baseUrl - Gateway 基础 URL
 * @param title    - API 标题
 * @param version  - API 版本
 * @returns OpenAPI 3.0.1 规范文档
 */
export function generateDifyOpenApiSpec(
  baseUrl: string,
  title = "TencentDB Agent Memory API",
  version = "0.1.0",
): Record<string, unknown> {
  const serverUrl = baseUrl.replace(/\/+$/, "");

  return {
    openapi: "3.0.1",
    info: {
      title,
      version,
      description: "TencentDB Agent Memory 跨平台记忆引擎 API — 为 Dify 工作流提供长期记忆能力",
    },
    servers: [{ url: serverUrl, description: "TDAI Gateway" }],
    paths: {
      "/health": {
        get: {
          operationId: "tdai_health",
          summary: "健康检查",
          description: "检查记忆服务健康状态。返回 ok 或 degraded。",
          responses: {
            "200": {
              description: "服务健康",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string", enum: ["ok", "degraded"] },
                      version: { type: "string" },
                      uptime: { type: "number" },
                      stores: {
                        type: "object",
                        properties: {
                          vectorStore: { type: "boolean" },
                          embeddingService: { type: "boolean" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/recall": {
        post: {
          operationId: "tdai_recall",
          summary: "记忆召回",
          description: "召回与当前查询相关的记忆上下文。在 LLM 调用前使用。",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["query", "session_key"],
                  properties: {
                    query: { type: "string", description: "查询文本" },
                    session_key: { type: "string", description: "会话标识符" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "召回结果",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      context: { type: "string", description: "记忆上下文" },
                      strategy: { type: "string" },
                      memory_count: { type: "number" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/capture": {
        post: {
          operationId: "tdai_capture",
          summary: "对话捕获",
          description: "记录一次对话交互到记忆系统。在 LLM 回复后使用。",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["user_content", "assistant_content", "session_key"],
                  properties: {
                    user_content: { type: "string", description: "用户消息" },
                    assistant_content: { type: "string", description: "助手回复" },
                    session_key: { type: "string", description: "会话标识符" },
                    session_id: { type: "string", description: "会话ID（可选）" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "捕获结果",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      l0_recorded: { type: "number" },
                      scheduler_notified: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/search/memories": {
        post: {
          operationId: "tdai_search_memories",
          summary: "搜索结构化记忆",
          description: "搜索 L1 结构化记忆（提取的知识、偏好、指令等）。",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["query"],
                  properties: {
                    query: { type: "string", description: "搜索查询" },
                    limit: { type: "number", description: "结果上限" },
                    type: { type: "string", description: "记忆类型" },
                    scene: { type: "string", description: "场景名" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "搜索结果",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      results: { type: "string" },
                      total: { type: "number" },
                      strategy: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/search/conversations": {
        post: {
          operationId: "tdai_search_conversations",
          summary: "搜索原始对话",
          description: "搜索 L0 原始对话记录。",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["query"],
                  properties: {
                    query: { type: "string", description: "搜索查询" },
                    limit: { type: "number", description: "结果上限" },
                    session_key: { type: "string", description: "限定会话" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "搜索结果",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      results: { type: "string" },
                      total: { type: "number" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/session/end": {
        post: {
          operationId: "tdai_end_session",
          summary: "结束会话",
          description: "结束会话并触发缓冲数据刷新到持久层。",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["session_key"],
                  properties: {
                    session_key: { type: "string", description: "会话标识符" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "刷新结果",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      flushed: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}
