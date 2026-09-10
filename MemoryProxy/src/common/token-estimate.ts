/**
 * Anthropic `count_tokens` 的本地应答口径（协议转换下的兜底）。
 *
 * 为什么需要：Claude Code 每轮发请求前都会先打 `/v1/messages/count_tokens`
 * 预检上下文用量；而当上游被转成 OpenAI Chat / Responses 时，上游没有这个
 * 端点，必须由代理本地算一个数回给客户端。它只用于客户端的上下文条提示，
 * **不作为计费依据**（计费仍以上游返回的 usage 为准）。
 *
 * 口径与仓库内既有实现对齐：用 tiktoken 的 `cl100k_base` 编码。
 *   - `MemoryCore/src/offload/fast-token-estimate.ts` 的注释明确该编码覆盖
 *     GPT-4 / Claude / DeepSeek / GLM / MiniMax；
 *   - `MemoryCore/src/offload-client/token-estimator.ts` 亦以 tiktoken 为主路径。
 *
 * 为什么不用「字符数 / 4」：实测（见 `scripts/qa/token-estimate-vs-upstream.mjs`）
 * 该公式在中文场景低估 **43%–68%**、英文场景反而高估 **42%**，只有代码/JSON
 * 大致可用；中文会话里客户端的上下文条会显著偏小（实际占用可能是显示的 2–3 倍）。
 *
 * 兜底：极端环境下 js-tiktoken 不可用时退回 CJK 感知的字符启发式，保证本接口
 * 永不抛错、永不返回 0（避免客户端误判“零上下文”）。
 */

import { getEncoding, type Tiktoken } from "js-tiktoken";

/** 每条消息的 role / 框架开销（上游 chat template 的近似值）。 */
const PER_MESSAGE_OVERHEAD_TOKENS = 4;

// undefined = 尚未初始化；null = 本环境不可用（走启发式兜底）
let _encoder: Tiktoken | null | undefined;

function getEncoder(): Tiktoken | null {
  if (_encoder !== undefined) return _encoder;
  try {
    _encoder = getEncoding("cl100k_base");
  } catch {
    _encoder = null;
  }
  return _encoder;
}

/** 把 content / system 的各种形态拍平成参与计数的文本。 */
function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        const b = block as Record<string, unknown> | null;
        if (typeof b?.text === "string") return b.text;
        if (typeof b?.content === "string") return b.content;
        try {
          return JSON.stringify(block) ?? "";
        } catch {
          return "";
        }
      })
      .join("\n");
  }
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * CJK 感知的字符启发式（仅在 tiktoken 不可用时兜底）。
 * 系数来自各语系在 BPE 下的平均 token/字符量级：汉字 ~1.4、假名/谚文 ~1.2、
 * 其它非 ASCII ~0.5、ASCII ~0.28（≈3.6 字符/token）。
 */
function heuristicTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x4e00 && cp <= 0x9fff) tokens += 1.4;
    else if ((cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0xac00 && cp <= 0xd7af)) tokens += 1.2;
    else if (cp === 0x0a) tokens += 0.05;
    else if (cp > 0x7f) tokens += 0.5;
    else tokens += 0.28;
  }
  return Math.ceil(tokens);
}

function countTokens(text: string): number {
  if (!text) return 0;
  const encoder = getEncoder();
  if (encoder) return encoder.encode(text).length;
  return heuristicTokens(text);
}

/** 计算 Anthropic Messages 请求的 input_tokens（纯函数，便于单测）。 */
export function estimateAnthropicInputTokens(body: unknown): number {
  const obj =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  let tokens = 0;
  if (obj.system !== undefined) tokens += countTokens(toText(obj.system));
  if (Array.isArray(obj.messages)) {
    for (const m of obj.messages) {
      const msg = (m ?? {}) as Record<string, unknown>;
      const role = typeof msg.role === "string" ? msg.role : "";
      tokens += countTokens(`${role}\n${toText(msg.content)}`);
      tokens += PER_MESSAGE_OVERHEAD_TOKENS;
    }
  }
  if (obj.tools !== undefined) tokens += countTokens(toText(obj.tools));
  if (obj.metadata !== undefined) tokens += countTokens(toText(obj.metadata));
  // 保守下限：空请求也算少量 token。
  return Math.max(1, Math.ceil(tokens));
}
