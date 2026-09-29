/**
 * Safe normalization for structured LLM output.
 *
 * Only known transport wrappers are removed. Arbitrary prose is deliberately
 * not searched for JSON because doing so can mistake hidden reasoning for the
 * model's final answer.
 */

const REASONING_TAGS = new Set(["think", "reasoning"]);

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function stripLeadingReasoningBlocks(value: string): string | null {
  let remaining = value.trim();

  while (remaining.startsWith("<")) {
    const open = remaining.match(/^<([a-zA-Z][\w-]*)(?:\s[^>]*)?>/);
    if (!open || !REASONING_TAGS.has(open[1].toLowerCase())) break;

    const closeTag = `</${open[1]}>`;
    const closeIndex = remaining.toLowerCase().indexOf(closeTag.toLowerCase(), open[0].length);
    if (closeIndex < 0) return null;

    remaining = remaining.slice(closeIndex + closeTag.length).trim();
  }

  return remaining;
}

function unwrapJsonFence(value: string): string | null {
  const match = value.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return match ? match[1].trim() : null;
}

function prepareStructuredPayload(raw: string): string | null {
  let payload = raw.replace(/^\uFEFF/, "").trim();

  // Support a known reasoning wrapper outside or inside a JSON code fence.
  for (let pass = 0; pass < 3; pass += 1) {
    const withoutReasoning = stripLeadingReasoningBlocks(payload);
    if (withoutReasoning === null) return null;
    payload = withoutReasoning;

    const unfenced = unwrapJsonFence(payload);
    if (unfenced === null) break;
    payload = unfenced;
  }

  return payload;
}

function fixTrailingCommas(value: string): string {
  return value.replace(/,\s*([}\]])/g, "$1");
}

/** Parse a final-answer payload after removing only known wrappers. */
export function extractStructuredJson<T = unknown>(raw: string): T | null {
  if (!raw || typeof raw !== "string") return null;

  const payload = prepareStructuredPayload(raw);
  if (!payload) return null;

  try {
    return JSON.parse(payload) as T;
  } catch {
    // Preserve the local parser's existing tolerance for trailing commas.
    try {
      return JSON.parse(fixTrailingCommas(payload)) as T;
    } catch {
      return null;
    }
  }
}

/**
 * Select the visible final-answer channel from an OpenAI-compatible response.
 * Hidden reasoning fields are intentionally never used as a fallback.
 */
export function extractOpenAiFinalAnswer(response: unknown): string {
  const root = asRecord(response);
  const choices = root?.choices;
  if (!Array.isArray(choices)) return "";

  const choice = asRecord(choices[0]);
  const message = asRecord(choice?.message);
  const content = message?.content;
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const item = asRecord(block);
        return item?.type === "text" && typeof item.text === "string" ? item.text : "";
      })
      .join("");
  }

  return "";
}

function classifyFailure(raw: string): "empty" | "reasoning-only" | "unclosed-reasoning" | "malformed" {
  if (!raw.trim()) return "empty";
  const withoutReasoning = stripLeadingReasoningBlocks(raw.replace(/^\uFEFF/, "").trim());
  if (withoutReasoning === null) return "unclosed-reasoning";
  if (!withoutReasoning || unwrapJsonFence(withoutReasoning) === "") return "reasoning-only";
  return "malformed";
}

/** A bounded, content-free parse failure suitable for logs and telemetry. */
export class StructuredOutputParseError extends Error {
  constructor(stage: string, raw: string) {
    super(`${stage} structured output parse failed (kind=${classifyFailure(raw)}, chars=${raw.length})`);
    this.name = "StructuredOutputParseError";
  }
}
