import { executeTdaiMcpTool, TDAI_MCP_TOOLS } from "./tool-registry.js";
import type { McpToolResult, TdaiMcpCore } from "./tool-registry.js";
import packageJson from "../../../package.json" with { type: "json" };

export const TDAI_MCP_SERVER_NAME = "memory-tencentdb";
export const TDAI_MCP_SERVER_VERSION = packageJson.version;
export const TDAI_MCP_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25"] as const;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

const SERVER_INFO = {
  name: TDAI_MCP_SERVER_NAME,
  version: TDAI_MCP_SERVER_VERSION,
};

const CAPABILITIES = {
  tools: {
    listChanged: false,
  },
};

export class TdaiMcpJsonRpcServer {
  constructor(private readonly core: TdaiMcpCore) {}

  async handle(raw: unknown): Promise<JsonRpcResponse | undefined> {
    const req = this.asRequest(raw);
    if (!req) {
      return this.error(null, -32600, "Invalid Request");
    }

    const isNotification = req.id === undefined;
    if (isNotification && this.isKnownNotification(req.method)) {
      return undefined;
    }
    if (isNotification) {
      return undefined;
    }

    try {
      switch (req.method) {
        case "server/discover":
          return this.result(req.id, {
            supportedVersions: [...TDAI_MCP_PROTOCOL_VERSIONS],
            serverInfo: SERVER_INFO,
            capabilities: CAPABILITIES,
          });
        case "initialize":
          return this.result(req.id, {
            protocolVersion: this.resolveProtocolVersion(req.params),
            serverInfo: SERVER_INFO,
            capabilities: CAPABILITIES,
          });
        case "tools/list":
          return this.result(req.id, {
            resultType: "complete",
            tools: TDAI_MCP_TOOLS,
          });
        case "tools/call":
          return this.result(req.id, await this.callTool(req.params));
        case "resources/list":
          return this.result(req.id, { resultType: "complete", resources: [] });
        case "prompts/list":
          return this.result(req.id, { resultType: "complete", prompts: [] });
        default:
          return this.error(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.result(req.id, {
        resultType: "complete",
        content: [{ type: "text", text: message }],
        isError: true,
      } satisfies McpToolResult);
    }
  }

  private async callTool(params: Record<string, unknown> | undefined): Promise<McpToolResult> {
    if (!params || typeof params.name !== "string") {
      throw new Error("tools/call requires params.name");
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    return executeTdaiMcpTool(this.core, params.name, args);
  }

  private resolveProtocolVersion(params: Record<string, unknown> | undefined): string {
    const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : undefined;
    if (requested && TDAI_MCP_PROTOCOL_VERSIONS.includes(requested as typeof TDAI_MCP_PROTOCOL_VERSIONS[number])) {
      return requested;
    }
    return "2025-11-25";
  }

  private asRequest(raw: unknown): JsonRpcRequest | undefined {
    if (!isRecord(raw)) return undefined;
    if (raw.jsonrpc !== "2.0") return undefined;
    if (typeof raw.method !== "string") return undefined;
    if (raw.params !== undefined && !isRecord(raw.params)) return undefined;
    return raw as unknown as JsonRpcRequest;
  }

  private isKnownNotification(method: string): boolean {
    return method === "notifications/initialized" || method === "notifications/cancelled";
  }

  private result(id: string | number | null | undefined, result: unknown): JsonRpcResponse {
    return {
      jsonrpc: "2.0",
      id: id ?? null,
      result,
    };
  }

  private error(
    id: string | number | null | undefined,
    code: number,
    message: string,
    data?: unknown,
  ): JsonRpcResponse {
    return {
      jsonrpc: "2.0",
      id: id ?? null,
      error: {
        code,
        message,
        ...(data === undefined ? {} : { data }),
      },
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
