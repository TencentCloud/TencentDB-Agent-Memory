/**
 * Pi coding-agent 客户端适配器。
 *
 * 协议实证（Pi `v0.84.2` 源码 + `--no-extensions` 真实请求）：
 *
 *   - `~/.pi/agent/models.json` 使用 `api: "openai-completions"` 时，Pi 发送
 *     标准流式 OpenAI Chat Completions 请求；因此直接复用共享 `handler.ts`，
 *     路径为 `/pi/:spaceId/v1/chat/completions`，不需要新增 `piHandler.ts`
 *   - Provider 开启 `sendSessionAffinityHeaders` 并选择 `openrouter` 格式后，
 *     Pi 会把当前运行时 Session ID 写入 `x-session-id`；Proxy 现有
 *     `resolveConversationId()` 已支持该 Header，不需要插件或 Header Hook
 *   - `x-team-id` / `x-agent-id` / `x-task-id` 由 Provider 静态 Header 提供，
 *     仍由共享 preset resolver 按当前用户可见资产校验，不能直接信任客户端值
 *
 * # 主请求与内部摘要请求
 *
 * Pi 的主 Agent Loop、自动 compaction、tree branch summary 共用同一 Provider。
 * 如果把内部摘要误当主请求，会同时产生三类污染：摘要器收到记忆注入、合成的
 * `<conversation>` 被记为真人输入、摘要结果进入 L0 / Skill。因此必须分流，
 * 但 Pi 没有独立摘要 URL 或 Header，只能使用 `v0.84.2` 已验证的 body 组合信号：
 *
 *   1. messages 恰好两条；
 *   2. 首条 role 为 system / developer，content 命中固定摘要 Prompt 前缀；
 *   3. 第二条 role 为 user，并以 `<conversation>` 包裹历史；
 *   4. tools 缺失或为空。
 *
 * 四项必须同时满足才判 auxiliary。任何未知或部分匹配都保守回落 main，避免 Pi
 * 未来调整非关键字段后把正常短对话误判为摘要，导致整轮跳过注入和回流。
 */

import { defaultAdapter } from "./default.js";
import type { AgentAdapter } from "./types.js";

const SUMMARY_SYSTEM_PREFIX =
  "You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant";
const SUMMARY_OPEN = "<conversation>";
const SUMMARY_CLOSE = "</conversation>";

interface MessageLike {
  role?: unknown;
  content?: unknown;
}

function textContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  return defaultAdapter.extractUserText(content);
}

/**
 * 判断请求是否为 Pi 内部摘要。
 *
 * handler 传入的是客户端 JSON 边界数据，故参数保留 `unknown`，逐字段收窄后再访问。
 * 畸形请求或未来新增 shape 一律返回 false，继续走更安全的 main 路径。
 */
export function isPiSummaryRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const candidate = body as { messages?: unknown; tools?: unknown };
  if (!Array.isArray(candidate.messages) || candidate.messages.length !== 2) return false;
  if (Array.isArray(candidate.tools) && candidate.tools.length > 0) return false;
  if (candidate.tools !== undefined && !Array.isArray(candidate.tools)) return false;

  const [system, user] = candidate.messages as MessageLike[];
  if ((system?.role !== "system" && system?.role !== "developer") || user?.role !== "user") return false;
  const systemText = textContent(system.content);
  const userText = textContent(user.content);
  return Boolean(
    systemText?.startsWith(SUMMARY_SYSTEM_PREFIX) &&
      userText?.trimStart().startsWith(SUMMARY_OPEN) &&
      userText.includes(SUMMARY_CLOSE),
  );
}

export const piAdapter: AgentAdapter = {
  agentKind: "pi",

  classifyRequest(body) {
    // compaction 与 branch summary 共用严格 envelope；禁止只按消息数量或 tools
    // 缺失这种单一弱信号判断，避免普通请求丢失记忆能力。
    return isPiSummaryRequest(body) ? "auxiliary" : "main";
  },

  extractUserText(content) {
    const text = textContent(content)?.trim();
    // 摘要副作用由 classifyRequest 的完整 envelope 统一门禁。这里不能只凭
    // `<conversation>` 单一弱信号丢弃文本，否则用户主动提交同名 XML 时，主请求
    // 虽然正确归类为 main，Skill 侧却会静默漏掉该轮真人输入。
    return text || null;
  },
};
