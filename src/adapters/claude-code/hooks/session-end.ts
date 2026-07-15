/**
 * session-end.ts —— Claude Code `SessionEnd` 钩子。
 *
 * 数据流（设计 §2）：
 *   SessionEnd(stdin JSON: {session_id, transcript_path, cwd, ...})
 *     → readStdinJson
 *     → ClaudeCodeEventBinding.onSessionEnd(ctx)
 *     → client.endSession() → POST /session/end → flush 当前会话状态
 *
 * 失败语义（记忆永不阻塞）：
 *   - stdin 非法/空 → 静默退出 0
 *   - endSession 失败 → binding 内部静默吞掉（onSessionEnd 不抛），钩子退出 0
 *   - 任何异常 → runHookSafely 吞掉，退出 0
 *
 * 用法（settings.json）：
 *   "SessionEnd": [{ "matcher": "", "hooks": [{ "type": "command",
 *     "command": "npx tsx src/adapters/claude-code/hooks/session-end.ts" }] }]
 */

import { pathToFileURL } from "node:url";
import type { TdaiClient } from "../../../sdk/client.js";
import {
  readStdinJson,
  buildClient,
  buildBinding,
  resolveContext,
  runHookSafely,
  log,
} from "./hook-runtime.js";

/**
 * session-end 钩子主体（可测：注入 stdin 字符串 + mock client）。
 *
 * @param stdinRaw  stdin 原文（测试注入）；生产入口不传，走 process.stdin
 * @param client    TdaiClient（测试注入 mock）；生产入口不传，buildClient() 构造真实客户端
 */
export async function main(stdinRaw?: string, client?: TdaiClient): Promise<void> {
  const input = await readStdinJson(stdinRaw);
  if (!input) {
    log("session-end: empty/invalid stdin, exiting");
    return;
  }

  const realClient = client ?? buildClient();
  const { binding, config } = buildBinding(realClient);
  const ctx = resolveContext(input, config);

  await binding.onSessionEnd(ctx);
  log("session-end: flush requested");
}

// ============================
// 生产入口
// ============================

const isMainModule =
  typeof process !== "undefined" &&
  !!process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
  runHookSafely("session-end", () => main()).then(() => process.exit(0));
}
