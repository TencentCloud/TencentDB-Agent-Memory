#!/usr/bin/env node
/**
 * memory-tencentdb-codex — Codex 适配器 CLI 入口。
 *
 * 命令:
 *   recall  — 召回记忆（Codex UserPromptSubmit hook 调用）
 *   capture — 记录对话（Codex Stop hook 调用）
 *   init    — 生成 Codex 配置文件
 */

import { GatewayClient } from "../src/adapters/shared/gateway-client.js";
import { CodexMemoryAdapter } from "../src/adapters/codex/codex-adapter.js";
import { generateCodexHookConfig, generateCodexMcpConfig } from "../src/adapters/codex/index.js";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const cmd = args[0];
const gatewayUrl = process.env.TDAI_GATEWAY_URL ?? "http://127.0.0.1:8420";
const apiKey = process.env.TDAI_GATEWAY_API_KEY;

async function main() {
  const client = new GatewayClient({ baseUrl: gatewayUrl, apiKey });
  const adapter = new CodexMemoryAdapter(client);

  switch (cmd) {
    case "recall": {
      const ctx = adapter.getHookContext();
      if (!ctx.prompt) {
        console.log("[tdai-codex] 无 prompt 上下文，跳过 recall");
        process.exit(0);
      }
      const result = await adapter.recall(ctx.prompt, ctx.sessionKey);
      console.log(result.context);
      break;
    }

    case "capture": {
      const ctx = adapter.getHookContext();
      if (!ctx.prompt || !ctx.lastAssistantMessage) {
        console.log("[tdai-codex] 无完整的 turn 上下文，跳过 capture，执行 session end");
        await adapter.endSession(ctx.sessionKey);
        process.exit(0);
      }
      const result = await adapter.capture(ctx.prompt, ctx.lastAssistantMessage, ctx.sessionKey);
      console.log(`[tdai-codex] 已记录 ${result.l0Recorded} 条对话`);
      break;
    }

    case "init": {
      const codexDir = path.join(process.cwd(), ".codex");
      if (!fs.existsSync(codexDir)) fs.mkdirSync(codexDir, { recursive: true });

      // 生成 config.json
      const mcpConfig = generateCodexMcpConfig("npx", gatewayUrl, apiKey);
      fs.writeFileSync(
        path.join(codexDir, "config.json"),
        JSON.stringify(mcpConfig, null, 2),
      );
      console.log(`[tdai-codex] 已生成 .codex/config.json`);

      // 生成 hooks.json
      const hookConfig = generateCodexHookConfig(gatewayUrl, apiKey);
      const hooksDir = path.join(codexDir, "hooks");
      if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });
      fs.writeFileSync(
        path.join(hooksDir, "hooks.json"),
        JSON.stringify(hookConfig, null, 2),
      );
      console.log(`[tdai-codex] 已生成 .codex/hooks/hooks.json`);
      break;
    }

    default:
      console.log(`用法: memory-tencentdb-codex <recall|capture|init>`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("[tdai-codex] 错误:", err.message);
  process.exit(1);
});
