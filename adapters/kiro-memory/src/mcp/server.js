#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { resolveConfig } from '../core/config.js';
import { GatewayClient } from '../core/gateway-client.js';
import { UnifiedQueryService } from '../core/query-service.js';
import { DiagnosticService } from '../core/diagnostic-service.js';
import { registerMemoryTools } from './tools.js';

const workspaceArg = () => {
  const index = process.argv.indexOf('--workspace');
  if (index === -1 || typeof process.argv[index + 1] !== 'string' || !process.argv[index + 1]) return process.cwd();
  return process.argv[index + 1];
};

export async function runMcpServer({ env = process.env, workspace = workspaceArg() } = {}) {
  const resolved = await resolveConfig({ env, workspace });
  const gatewayClient = new GatewayClient(resolved.config);
  const queryService = new UnifiedQueryService({ gatewayClient });
  const diagnosticService = new DiagnosticService({ config: resolved.config, provenance: resolved.provenance, gatewayClient });
  const server = new McpServer({ name: 'tdai-memory', version: '2.0.0' });
  registerMemoryTools(server, {
    queryService,
    diagnosticService,
    config: { ...resolved.config, provenance: resolved.provenance },
  });
  await server.connect(new StdioServerTransport());
  return server;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`).href) {
  runMcpServer().catch(() => {
    process.stderr.write('tdai-memory MCP startup failed\n');
    process.exitCode = 1;
  });
}
