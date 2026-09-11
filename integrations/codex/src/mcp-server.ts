import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AdapterLogger, CodexAdapterConfig } from "./types.js";
import { GatewayClient } from "./gateway-client.js";
import { GatewaySupervisor } from "./gateway-supervisor.js";
import { ResultFormatter } from "./result-formatter.js";
import { SessionResolver } from "./session-resolver.js";
import { TOOL_DEFINITIONS, type ToolName } from "./tools.js";
import { ToolRouter } from "./tool-router.js";

export interface CodexMcpServerOptions {
  config: CodexAdapterConfig;
  logger: AdapterLogger;
}

export class CodexMcpServer {
  readonly server: Server;
  readonly router: ToolRouter;
  readonly supervisor: GatewaySupervisor;

  constructor(options: CodexMcpServerOptions) {
    const { config, logger } = options;
    const client = new GatewayClient({
      baseUrl: config.gatewayUrl,
      timeoutMs: config.requestTimeoutMs,
      apiKey: config.gatewayApiKey,
    });
    this.supervisor = new GatewaySupervisor({
      client,
      gatewayUrl: config.gatewayUrl,
      gatewayCommand: config.gatewayCommand,
      logDir: config.logDir,
      logger,
      enabled: config.enableSupervisor,
    });
    this.router = new ToolRouter(
      config,
      client,
      this.supervisor,
      new SessionResolver({ explicitSessionKey: config.explicitSessionKey }),
      new ResultFormatter(config.resultMaxChars),
      logger,
    );
    this.server = new Server(
      { name: "memory-tencentdb-codex", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name as ToolName;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      if (!TOOL_DEFINITIONS.some((tool) => tool.name === name)) {
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
      return this.router.call(name, args);
    });
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  async shutdown(): Promise<void> {
    await this.supervisor.shutdown();
    await this.server.close();
  }
}
