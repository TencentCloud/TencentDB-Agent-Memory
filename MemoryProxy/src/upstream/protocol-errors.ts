/**
 * 协议接线错误体转换：Chat / Responses（OpenAI 风格）与 Anthropic 的错误
 * JSON schema 互转。只处理非 2xx 响应体；无法解析为 JSON 时原样透传，
 * 由上层按 HTTP 状态码继续报错。
 *
 * OpenAI 风格（Chat / Responses 共用）：
 *   { "error": { "message": "...", "type": "...", "param": ..., "code": ... } }
 * Anthropic 风格：
 *   { "type": "error", "error": { "type": "...", "message": "..." } }
 */

interface RecordLike {
  [key: string]: unknown;
}

function asRecord(v: unknown): RecordLike | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as RecordLike)
    : null;
}

/** 判断是否为 OpenAI 风格错误 JSON（error 对象且带 message）。 */
export function isOpenAiErrorJson(json: unknown): boolean {
  const root = asRecord(json);
  if (!root || root.type === "error") return false;
  const err = asRecord(root.error);
  return err !== null && typeof err.message === "string";
}

/** 判断是否为 Anthropic 风格错误 JSON（type=error 或 error 对象带 message）。 */
export function isAnthropicErrorJson(json: unknown): boolean {
  const root = asRecord(json);
  return root !== null && root.type === "error" && asRecord(root.error) !== null;
}

/** OpenAI 风格错误 → Anthropic 风格错误。非错误 JSON 时返回 null。 */
export function openAiErrorToAnthropic(json: unknown): RecordLike | null {
  const err = asRecord(asRecord(json)?.error);
  if (!err || typeof err.message !== "string") return null;
  return {
    type: "error",
    error: {
      type: typeof err.type === "string" && err.type.length > 0 ? err.type : "api_error",
      message: err.message,
    },
  };
}

/** Anthropic 风格错误 → OpenAI 风格错误。非错误 JSON 时返回 null。 */
export function anthropicErrorToOpenAi(json: unknown): RecordLike | null {
  const root = asRecord(json);
  const err = asRecord(asRecord(json)?.error);
  if (root?.type !== "error" || !err || typeof err.message !== "string") return null;
  return {
    error: {
      message: err.message,
      type: typeof err.type === "string" && err.type.length > 0 ? err.type : "api_error",
    },
  };
}

function tryConvert(text: string, fn: (json: unknown) => RecordLike | null): string | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const converted = fn(json);
  return converted ? JSON.stringify(converted) : null;
}

/**
 * 把任意错误体文本转换为 Anthropic 风格（客户端为 Claude Code）。
 * 非 JSON / 已符合目标 schema / 无法识别时原样返回。
 */
export function toAnthropicErrorBody(text: string): string {
  return (
    tryConvert(text, (json) =>
      isAnthropicErrorJson(json) || !isOpenAiErrorJson(json)
        ? null
        : openAiErrorToAnthropic(json),
    ) ?? text
  );
}

/**
 * 把任意错误体文本转换为 OpenAI 风格（客户端为 Chat / Responses）。
 * 非 JSON / 已符合目标 schema / 无法识别时原样返回。
 */
export function toOpenAiErrorBody(text: string): string {
  return (
    tryConvert(text, (json) =>
      isOpenAiErrorJson(json) || !isAnthropicErrorJson(json)
        ? null
        : anthropicErrorToOpenAi(json),
    ) ?? text
  );
}
