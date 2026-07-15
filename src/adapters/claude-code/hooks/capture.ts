/**
 * capture.ts —— Claude Code `Stop` 钩子。
 *
 * 数据流（设计 §2）：
 *   Stop(stdin JSON: {session_id, transcript_path, cwd, stop_hook_active, ...})
 *     → readStdinJson
 *     → 读 transcript_path（JSONL）→ 提取最后一轮 user/assistant 文本
 *     → ClaudeCodeEventBinding.onTurnEnd({userText, assistantText, ...}, ctx)
 *     → client.capture() → POST /capture → L0 入库 + 流水线调度
 *
 * transcript 格式（Claude Code JSONL，每行一条消息）：
 *   {"type":"user","message":{"role":"user","content":"文本" | [内容块]}}
 *   {"type":"assistant","message":{"role":"assistant","content":[{type:"text",text:"..."}]}}
 * content 可能是 string 或内容块数组，本解析器两种都兼容。
 *
 * 失败语义（记忆永不阻塞）：
 *   - stdin 非法/空、transcript 缺失/不可读、无 user/assistant 文本 → 静默退出 0
 *   - capture 失败 → binding 返回 null，钩子退出 0
 *   - 任何异常 → runHookSafely 吞掉，退出 0
 *
 * 用法（settings.json）：
 *   "Stop": [{ "matcher": "", "hooks": [{ "type": "command",
 *     "command": "npx tsx src/adapters/claude-code/hooks/capture.ts" }] }]
 */

import fs from "node:fs";
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
import type { ClaudeCodeHookInput } from "./hook-runtime.js";

/**
 * capture 钩子主体（可测：注入 stdin 字符串 + mock client）。
 *
 * @param stdinRaw  stdin 原文（测试注入）；生产入口不传，走 process.stdin
 * @param client    TdaiClient（测试注入 mock）；生产入口不传，buildClient() 构造真实客户端
 * @param fsImpl    文件系统读函数（测试注入 mock）；默认 fs.readFileSync
 */
export async function main(
  stdinRaw?: string,
  client?: TdaiClient,
  fsImpl: (path: string) => string = (p) => fs.readFileSync(p, "utf-8"),
): Promise<void> {
  const input = await readStdinJson(stdinRaw);
  if (!input) {
    log("capture: empty/invalid stdin, exiting");
    return;
  }

  const transcriptPath = input["transcript_path"];
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) {
    log("capture: no transcript_path in input, exiting");
    return;
  }

  const turn = extractLastTurn(transcriptPath, fsImpl);
  if (!turn) {
    log("capture: could not extract user/assistant from transcript, exiting");
    return;
  }

  const realClient = client ?? buildClient();
  const { binding, config } = buildBinding(realClient);
  const ctx = resolveContext(input, config);

  const ack = await binding.onTurnEnd(
    {
      userText: turn.userText,
      assistantText: turn.assistantText,
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
    },
    ctx,
  );

  if (ack) {
    log(`capture: recorded l0=${ack.l0Recorded} notified=${ack.schedulerNotified}`);
  } else {
    log("capture: binding returned null (capture skipped or failed)");
  }
}

/**
 * 从 transcript JSONL 提取最后一轮的 user + assistant 文本。
 *
 * 策略：逐行解析，收集所有 user/assistant 文本，返回最后一条 user +
 * 最后一条 assistant。两者都非空才返回（否则 null）。
 *
 * @param fsImpl 文件读函数（测试注入 mock）
 */
export function extractLastTurn(
  transcriptPath: string,
  fsImpl: (path: string) => string = (p) => fs.readFileSync(p, "utf-8"),
): { userText: string; assistantText: string } | null {
  let raw: string;
  try {
    raw = fsImpl(transcriptPath);
  } catch {
    return null;
  }

  let lastUser = "";
  let lastAssistant = "";

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // 跳过非法行（如部分写入）
    }
    if (!obj || typeof obj !== "object") continue;

    const type = (obj as { type?: unknown }).type;
    const message = (obj as { message?: unknown }).message;
    if (!message || typeof message !== "object") continue;

    const role = (message as { role?: unknown }).role;
    const content = (message as { content?: unknown }).content;
    const text = contentToText(content);
    if (!text) continue;

    // 优先用顶层 type，回退 message.role（不同版本兼容）
    if (type === "user" || role === "user") {
      lastUser = text;
    } else if (type === "assistant" || role === "assistant") {
      lastAssistant = text;
    }
  }

  if (!lastUser || !lastAssistant) return null;
  return { userText: lastUser, assistantText: lastAssistant };
}

/**
 * 把 transcript 消息的 content 字段归一为纯文本。
 *
 * content 两种形态（Claude Code 均会出现）：
 *   - string → 直接返回
 *   - Array<{type:"text", text:string} | {type:"tool_use"|...}> → 拼接所有 text 块
 *   - 其他 → 返回空串
 */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === "object") {
          const b = block as { type?: string; text?: unknown };
          if (b.type === "text" && typeof b.text === "string") return b.text;
        }
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

// ============================
// 生产入口
// ============================

const isMainModule =
  typeof process !== "undefined" &&
  !!process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
  runHookSafely("capture", () => main()).then(() => process.exit(0));
}
