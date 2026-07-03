/**
 * L1 Summarization Prompt — migrated from context-offload-server.
 *
 * Converts tool call/result pairs into high-density JSON summaries.
 */

// ─── System Prompt ───────────────────────────────────────────────────────────

export const L1_SYSTEM_PROMPT = `------ AI ---------"-------"。-------------------，--------------（--toolcall-tool result-----summary--），--------- JSON --。

------，-----------：
1. ----：---------，----------------。--------，------------。
2. ----：-------------，----"---------"、"--------"、"---------"-"---------"。
3. ----：----------------（--：-------、------、-------，------------）。

【------】
------------- JSON ---- [{...}]，----**--**------：
- "tool_call": ---------。------：
  · ------ tool pair --- [NEEDS_COMPRESS]，-------+--------------（≤150--），-----、----（-----、----），------/-------。
    --：exec({"command":"python3 -c 'import csv; ...200---...'"}) → "exec: -- Python （xx/xx/xx.sh，---------）---- sales_channels.csv ----"
    --：write_file({"path":"/root/app.py","content":"...5000--..."}) → "write_file: -- /root/app.py (Flask -----)，-----……"
  · ----- [NEEDS_COMPRESS]，-----------（---------）。
- "summary": -----------（≤200---）。-----------------，---------/----。
- "tool_call_id": --- tool_call_id（------）。
- "timestamp": ---------（+08:00）ISO 8601 ---（------）。
- "score"（**--**）: -------------summary---------，---0-10--，---10--summary------。

【----】
------ JSON --，----------------。`;

// ─── Constants ───────────────────────────────────────────────────────────────

const PARAMS_MAX_LEN = 500;
const RESULT_MAX_LEN = 2000;
const COMPRESS_THRESHOLD = 200;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface L1ToolPair {
  toolName: string;
  toolCallId: string;
  params: unknown;
  result: unknown;
  timestamp: string;
}

// ─── User Prompt Builder ─────────────────────────────────────────────────────

/**
 * Build the L1 user prompt for summarization.
 * Mirrors context-offload-server/internal/service/prompt/BuildL1UserPrompt.
 */
export function buildL1UserPrompt(recentMessages: string, pairs: L1ToolPair[]): string {
  const parts: string[] = [];

  parts.push("## --------（--------）：");
  parts.push(recentMessages);
  parts.push("\n## Tool call/result pairs to summarize:");

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const paramsStr = truncate(stringify(p.params), PARAMS_MAX_LEN);
    const resultStr = truncate(stringify(p.result), RESULT_MAX_LEN);
    const canonical = `${p.toolName}(${stringify(p.params)})`;
    const needsCompress = canonical.length > COMPRESS_THRESHOLD;

    parts.push(`--- Tool Pair ${i + 1} ---`);
    parts.push(`tool_call_id: ${p.toolCallId}`);
    parts.push(`timestamp: ${p.timestamp}`);
    if (needsCompress) {
      parts.push(`Tool: ${p.toolName} [NEEDS_COMPRESS]`);
    } else {
      parts.push(`Tool: ${p.toolName}`);
    }
    parts.push(`Params: ${paramsStr}`);
    parts.push(`Result: ${resultStr}\n`);
  }

  parts.push("Summarize each pair into the JSON array format described.");
  return parts.join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}
