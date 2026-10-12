/**
 * LLM 参数容错包装器。
 *
 * LLM 有时会：
 *   1. 在工具调用里混入 schema 未声明的多余字段（如 `explanation`, `reasoning`）
 *   2. 把数值/数组/对象以 JSON 字符串形式传入（如 `top_k: "5"`）
 *
 * 此模块在 Zod parse 之前执行两步容错：
 *   1. 剥离多余参数（保留 allowedKeys 里的字段）
 *   2. 对值为字符串的字段，若能解析成数字/数组/对象则自动矫正类型
 *
 * 参考：hindsight-api `_make_tools_tolerant`。
 */

/**
 * 剥离 `input` 中未在 `allowedKeys` 里声明的字段，并矫正字符串编码的基本类型。
 *
 * @param input - LLM 传入的工具调用参数（原始对象）
 * @param allowedKeys - schema 声明的合法字段名集合
 * @returns 清洗后的参数对象（浅拷贝，不修改原始对象）
 */
export function tolerantParse(
  input: Record<string, unknown>,
  allowedKeys: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const key of allowedKeys) {
    if (!(key in input)) continue;
    const raw = input[key];
    out[key] = coerceValue(raw);
  }

  return out;
}

/**
 * 将字符串编码的数字、数组、对象矫正为对应 JS 类型。
 * 非字符串值原样返回。
 */
function coerceValue(value: unknown): unknown {
  if (typeof value !== "string") return value;

  const trimmed = value.trim();

  // 数字（整数或浮点，含负数）
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isNaN(n)) return n;
  }

  // JSON 数组或对象
  if ((trimmed.startsWith("[") && trimmed.endsWith("]")) ||
      (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // 不是合法 JSON，原样返回字符串
    }
  }

  // boolean
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  return value;
}
