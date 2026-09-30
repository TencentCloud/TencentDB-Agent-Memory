#!/usr/bin/env node
/**
 * MCP stdio adapter for TDAI memory.
 *
 * The server exposes TdaiCore capabilities as MCP tools so MCP-compatible
 * agents (Claude Code, Codex, Cursor, etc.) can recall, capture, and search
 * TencentDB Agent Memory without depending on the OpenClaw plugin API.
 */

import readline from "node:readline";
import { stdin, stdout, stderr } from "node:process";
import { TdaiCore } from "../../core/tdai-core.js";
import { StandaloneHostAdapter } from "../standalone/host-adapter.js";
import { loadGatewayConfig } from "../../gateway/config.js";
import { initDataDirectories } from "../../utils/pipeline-factory.js";
import { SessionFilter } from "../../utils/session-filter.js";
import type { GatewayConfig } from "../../gateway/config.js";
import type { Logger } from "../../core/types.js";
import { TdaiMcpJsonRpcServer } from "./json-rpc.js";

const TAG = "[tdai-mcp]";

function createStderrLogger(): Logger {
  return {
    debug: (message: string) => stderr.write(`${TAG} ${message}\n`),
    info: (message: string) => stderr.write(`${TAG} ${message}\n`),
    warn: (message: string) => stderr.write(`${TAG} WARN ${message}\n`),
    error: (message: string) => stderr.write(`${TAG} ERROR ${message}\n`),
  };
}

async function createCore(config: GatewayConfig, logger: Logger): Promise<TdaiCore> {
  initDataDirectories(config.data.baseDir);

  const adapter = new StandaloneHostAdapter({
    dataDir: config.data.baseDir,
    llmConfig: config.llm,
    logger,
    platform: "mcp",
  });

  const core = new TdaiCore({
    hostAdapter: adapter,
    config: config.memory,
    sessionFilter: new SessionFilter(config.memory.capture.excludeAgents),
  });
  await core.initialize();
  return core;
}

async function main(): Promise<void> {
  const logger = createStderrLogger();
  const config = loadGatewayConfig();
  const core = await createCore(config, logger);
  const server = new TdaiMcpJsonRpcServer(core);
  const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });

  logger.info(`MCP stdio server started: dataDir=${config.data.baseDir}`);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await core.destroy();
    } catch (err) {
      logger.warn(`Core destroy failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  rl.on("line", (line) => {
    void (async () => {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }) + "\n");
        return;
      }

      const response = await server.handle(parsed);
      if (response) {
        stdout.write(`${JSON.stringify(response)}\n`);
      }
    })().catch((err) => {
      logger.error(`Unhandled request error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    });
  });

  rl.on("close", () => {
    void close().finally(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    void close().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void close().finally(() => process.exit(0));
  });
}

const isMain = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.mjs") || process.argv[1]?.endsWith("memory-tencentdb-mcp.mjs");
if (isMain) {
  main().catch((err) => {
    stderr.write(`${TAG} startup failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
