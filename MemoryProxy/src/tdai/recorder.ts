import type { TdaiClient } from "./client.js";
import type { TdaiIdentity, TdaiMessage } from "./types.js";
import { extractUserQueryText } from "../common/user-query-extractor.js";
import {
  collectToolCalls,
  formAnswerFromToolMessage,
  formAnswerFromToolResultBlocks,
  type ToolCallMeta,
} from "../common/form-answer-extractor.js";

/**
 * 从最后一条 user 消息中抽取「真正的用户提问」，写入 L0。
 *
 * 背景：CodeBuddy / Claude Code / DSH 等编码 agent 的 user 消息里除了真实问题，
 * 还塞了大量 harness 上下文（<additional_data>、current_time、<system_reminder>、
 * DSH 的 `Current runtime context.` 快照等）。如果把整条消息原样写进 L0，记忆
 * 会被这些噪声污染，而且每轮都不一样、检索价值极低。因此这里只保留真实提问。
 *
 * 抽取算法在 `common/user-query-extractor.ts` 内实现（tdai / mem-command /
 * codebuddy adapter 共用同一份，避免语义漂移）；本模块只负责"取最后一条
 * user message → 抽 query 文本 → 组装 TdaiMessage"这几步。
 *
 * 待选表单（`ask_user_question`）的答案**不在 role=user 上**：它随 tool 结果
 * 回流（OpenAI `role:"tool"` / Anthropic `user.tool_result`）。只扫 user 角色
 * 会让整轮变成"用表单之前那句提问 + 表单之后的回答"，用户实际选了什么、
 * 手填了什么都不进 L0。这里把表单答案也当作一次人类输入，取**由近及远
 * 第一条**人类输入（真 user 文本或表单答案），见 `common/form-answer-extractor.ts`。
 * session-init（proxy 自己伪造的选 Team/Agent/Task 表单）不参与抽取。
 */

// 保留 re-export，避免下游（含单测）import 路径变化引发一次性大改。
export { extractUserQueryText };

export function extractLatestUserMessage(messages: unknown[]): TdaiMessage | null {
  // 只在真的遇到 tool 消息时才扫历史，绝大多数轮次不需要
  let toolCalls: Map<string, ToolCallMeta> | null = null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (!msg) continue;

    if (msg.role === "user") {
      // 只取真实 user_query，避免把 harness 上下文写进 L0
      const content = extractUserQueryText(extractContentText(msg.content));
      if (content.trim()) return { role: "user", content };

      // Anthropic 把 tool_result 塞在 user 角色里；body 文本为空说明这条
      // user 消息只是工具回流，再看里面有没有表单答案
      toolCalls ??= collectToolCalls(messages);
      const fromToolResult = formAnswerFromToolResultBlocks(msg.content, toolCalls);
      if (fromToolResult) return { role: "user", content: fromToolResult };
      continue;
    }

    if (msg.role === "tool") {
      toolCalls ??= collectToolCalls(messages);
      const fromForm = formAnswerFromToolMessage(msg, toolCalls);
      if (fromForm) return { role: "user", content: fromForm };
    }
  }
  return null;
}

export async function recordTdaiTurn(client: TdaiClient, identity: TdaiIdentity | null, userMessage: TdaiMessage | null, assistantContent: string | null | undefined): Promise<void> {
  if (!identity || !userMessage) return;
  const messages: TdaiMessage[] = [userMessage];
  if (assistantContent?.trim()) {
    messages.push({ role: "assistant", content: assistantContent });
  }
  await client.addConversation(identity, messages);
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return "";
      const p = part as Record<string, unknown>;
      if (p.type !== "text" && p.type !== "input_text") return "";
      return typeof p.text === "string" ? p.text : "";
    }).filter(Boolean).join("\n");
  }
  return "";
}
