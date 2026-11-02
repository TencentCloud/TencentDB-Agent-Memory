/**
 * 在压缩阶段保护 skill 正文 —— proxy 主动加载（client_tool）的 skill
 *
 * 做法：压缩前把这些工具结果的正文替换为短占位（低于压缩/归档阈值），压缩后按原
 * 引用写回原文。
 *
 * 覆盖三种协议的工具结果形状：
 *   - anthropic : user.content[] 中的 tool_result（tool_use_id）
 *   - openai    : role="tool" 消息（tool_call_id）
 *   - responses : function_call_output 项（call_id）
 */

import { SKILL_LOAD_TOOL_PREFIX } from "./detect.js";

const PLACEHOLDER = "[skill-content-protected]";

export function isProtectedSkillCallId(id: unknown): boolean {
  return typeof id === "string" && id.startsWith(SKILL_LOAD_TOOL_PREFIX);
}

type Rec = Record<string, unknown>;

/**
 * 原地把受保护结果替换为占位，返回 restore()：调用后把原 `content` / `output`
 * 写回同一对象。无受保护项时返回 no-op。
 */
export function protectSkillResults(items: unknown[]): () => void {
  const saved: Array<{ target: Rec; key: string; value: unknown }> = [];
  const stash = (target: Rec, key: string) => {
    saved.push({ target, key, value: target[key] });
    target[key] = PLACEHOLDER;
  };

  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const it = raw as Rec;
    // openai chat: { role: "tool", tool_call_id, content }
    if (it.role === "tool" && isProtectedSkillCallId(it.tool_call_id)) {
      stash(it, "content");
      continue;
    }
    // responses: { type: "function_call_output", call_id, output }
    if (it.type === "function_call_output" && isProtectedSkillCallId(it.call_id)) {
      stash(it, "output");
      continue;
    }
    // anthropic: user.content[] 中的 tool_result
    if (it.role === "user" && Array.isArray(it.content)) {
      for (const b of it.content as Rec[]) {
        if (b && b.type === "tool_result" && isProtectedSkillCallId(b.tool_use_id)) stash(b, "content");
      }
    }
  }

  if (saved.length === 0) return () => {};
  return () => {
    for (const { target, key, value } of saved) target[key] = value;
  };
}
