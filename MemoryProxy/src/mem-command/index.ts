/**
 * mem-command 模块统一入口
 *
 * 提供：
 *  - parseMemCommand()  — 检测是否为 mem: 命令
 *  - executeMemCommand() — 执行命令并返回结果
 *  - isMemCommandEnabled() — 检查配置开关
 */

import type { MemCommandConfig } from "../types.js";
import type { MemCommandContext, MemCommandResult } from "./types.js";
import { parseMemCommand, parseCommandFromText, type ParsedMemCommand } from "./parser.js";
import { buildMemResponse } from "./response-builder.js";
import { executeHelp } from "./commands/help.js";
import { executeSync } from "./commands/sync.js";
import { executeCreateSkill } from "./commands/create-skill.js";

export { parseMemCommand, parseCommandFromText, type ParsedMemCommand } from "./parser.js";
export { buildMemResponse } from "./response-builder.js";
export type { MemCommandContext, MemCommandResult } from "./types.js";
export { getHelpText } from "./commands/help.js";

/** 已知命令列表 */
const KNOWN_COMMANDS = new Set(["sync", "create-skill", "help"]);

/**
 * 检查 memCommand 功能是否启用，且命令是否在白名单中。
 */
export function isMemCommandAllowed(config: MemCommandConfig, command: string): boolean {
  if (!config.enabled) return false;
  // 白名单为空 = 全部允许
  if (config.allowedCommands.length === 0) return true;
  return config.allowedCommands.includes(command);
}

/**
 * 执行已解析的 mem: 命令。
 * 调用方已确认 isMemCommandAllowed 通过。
 */
export async function executeMemCommand(
  cmd: ParsedMemCommand,
  ctx: MemCommandContext,
): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;

  // 未知命令
  if (!KNOWN_COMMANDS.has(cmd.command)) {
    const text = `❌ 未知命令：\`mem:${cmd.command}\`。输入 \`mem:help\` 查看可用命令。`;
    return {
      success: false,
      messageText: text,
      response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }),
    };
  }

  switch (cmd.command) {
    case "help":
      return executeHelp(ctx);
    case "sync":
      return executeSync(ctx);
    case "create-skill":
      return executeCreateSkill(ctx);
    default: {
      const text = `❌ 未知命令：\`mem:${cmd.command}\``;
      return {
        success: false,
        messageText: text,
        response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }),
      };
    }
  }
}
