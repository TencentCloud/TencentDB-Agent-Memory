/**
 * recall.ts —— Claude Code `UserPromptSubmit` 钩子。
 *
 * 数据流（设计 §2）：
 *   UserPromptSubmit(stdin JSON: {session_id, prompt, cwd, ...})
 *     → readStdinJson
 *     → ClaudeCodeEventBinding.onUserPrompt(prompt, ctx)
 *     → client.recall() → POST /recall
 *     → 若返回 RecallInjection → stdout 输出 {hookSpecificOutput:{additionalContext}}
 *     → Claude Code 把 additionalContext 注入到用户 prompt 前
 *
 * 失败语义（记忆永不阻塞）：
 *   - stdin 非法/空 → 静默退出 0
 *   - recall 返回 null（无记忆/调用失败）→ 不输出，退出 0
 *   - 任何异常 → runHookSafely 吞掉，退出 0
 *
 * 用法（settings.json）：
 *   "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command",
 *     "command": "npx tsx src/adapters/claude-code/hooks/recall.ts" }] }]
 *
 * 独立调试：
 *   echo '{"session_id":"s1","prompt":"我喜欢什么语言","cwd":"/tmp"}' | npx tsx .../recall.ts
 */

import { pathToFileURL } from "node:url";
import type { TdaiClient } from "../../../sdk/client.js";
import {
  readStdinJson,
  buildClient,
  buildBinding,
  resolveContext,
  emitAdditionalContext,
  runHookSafely,
  log,
} from "./hook-runtime.js";
import type { ClaudeCodeHookInput } from "./hook-runtime.js";

/**
 * recall 钩子主体（可测：注入 stdin 字符串 + mock client）。
 *
 * @param stdinRaw  stdin 原文（测试注入）；生产入口不传，走 process.stdin
 * @param client    TdaiClient（测试注入 mock）；生产入口不传，buildClient() 构造真实客户端
 */
export async function main(stdinRaw?: string, client?: TdaiClient): Promise<void> {
  const input = await readStdinJson(stdinRaw);
  if (!input) {
    log("recall: empty/invalid stdin, exiting");
    return;
  }

  const prompt = readPrompt(input);
  if (!prompt) {
    log("recall: no prompt in input, exiting");
    return;
  }

  const realClient = client ?? buildClient();
  const { binding, config } = buildBinding(realClient);
  const ctx = resolveContext(input, config);

  const injection = await binding.onUserPrompt(prompt, ctx);
  // RecallInjection.additionalContext 是可选字段；空串/undefined 都不注入
  const injectedText = injection?.additionalContext?.trim();
  if (injectedText) {
    emitAdditionalContext(injectedText);
    log(`recall: injected ${injectedText.length} chars`);
  } else {
    log("recall: no context to inject");
  }
}

/** 从钩子输入提取用户 prompt（字段名 prompt，对齐官方 UserPromptSubmit 输入）。 */
function readPrompt(input: ClaudeCodeHookInput): string {
  const p = input["prompt"];
  return typeof p === "string" ? p.trim() : "";
}

// ============================
// 生产入口
// ============================

const isMainModule =
  typeof process !== "undefined" &&
  !!process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
  runHookSafely("recall", () => main()).then(() => process.exit(0));
}
