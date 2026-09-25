/**
 * mem-command 模块统一入口
 *
 * 提供：
 *  - parseMemCommand()  — 检测是否为 mem: 命令
 *  - executeMemCommand() — 执行命令并返回结果
 *
 * 命令拦截**恒定启用**（无配置开关），命令白名单已废弃 —— 未知命令由
 * executeMemCommand 内的 KNOWN_COMMANDS 兜底返回"未知命令"提示。
 */

import type { MemCommandContext, MemCommandResult } from "./types.js";
import { parseMemCommand, parseCommandFromText, type ParsedMemCommand } from "./parser.js";
import { buildMemResponse } from "./response-builder.js";
import { executeHelp } from "./commands/help.js";
import { executeSync } from "./commands/sync.js";
import { executeCreateSkill } from "./commands/create-skill.js";
import { executeCreateTask } from "./commands/create-task.js";
import { executeUpdateTask } from "./commands/update-task.js";
import { executeSessionReset } from "./commands/session-reset.js";

export { parseMemCommand, parseCommandFromText, type ParsedMemCommand } from "./parser.js";
export { buildMemResponse } from "./response-builder.js";
export type { MemCommandContext, MemCommandResult, MemCommandName, MemCommandMessage } from "./types.js";
export { getHelpText } from "./commands/help.js";
export { extractSimpleMessages, truncateArgs } from "./utils.js";

/** 已知命令列表 */
const KNOWN_COMMANDS = new Set([
  "sync",
  "create-skill",
  "create-task",
  "update-task",
  "session-reset",
  "help",
]);

/**
 * 执行已解析的 mem: 命令。
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
    case "create-task":
      return executeCreateTask(ctx);
    case "update-task":
      return executeUpdateTask(ctx);
    case "session-reset":
      return executeSessionReset(ctx);
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
