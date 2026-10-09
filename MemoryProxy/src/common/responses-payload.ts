/**
 * Readers for OpenAI Responses API response payloads.
 *
 * Shared by every handler that speaks the Responses wire protocol (codex,
 * workbuddy). They stay here rather than in one handler because the handlers
 * are deliberately decoupled from each other — a change to one client must not
 * require touching another.
 */

import type { UpstreamToolCall } from "../request-prepare-adapter.js";

/**
 * Tool calls of a Responses `output[]`, keyed by `call_id`.
 *
 * `call_id` rather than the item `id`: a follow-up turn pairs its
 * `function_call_output` on that value alone, and an incremental session
 * (`previous_response_id`) resends nothing else to match on.
 *
 * `arguments` stays verbatim — agent clients re-serialize tool calls against
 * their own schema and drop fields it does not declare, so this is the last
 * point where whatever the preparation stage added is still intact.
 */
export function collectResponsesToolCalls(output: unknown): UpstreamToolCall[] {
  if (!Array.isArray(output)) return [];
  const calls: UpstreamToolCall[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    if (it.type !== "function_call") continue;
    const callId = typeof it.call_id === "string" ? it.call_id : "";
    if (!callId) continue;
    calls.push({
      id: callId,
      name: typeof it.name === "string" ? it.name : "",
      arguments: typeof it.arguments === "string" ? it.arguments : "",
    });
  }
  return calls;
}

/**
 * Merge tool calls into an accumulator keyed by `call_id`.
 *
 * Streams expose the same call twice — once per `response.output_item.done`,
 * once in the terminal `response.completed.output[]` — and not every upstream
 * emits both. Later entries win so the terminal frame can correct a partial
 * one, and the `call_id` key keeps the pair from being counted twice.
 */
export function mergeResponsesToolCalls(
  acc: Map<string, UpstreamToolCall>,
  output: unknown,
): void {
  for (const call of collectResponsesToolCalls(output)) {
    acc.set(call.id, call);
  }
}

/**
 * Assistant text of a Responses payload — the `output_text` convenience field
 * when the upstream provides it, else the text parts of its message items.
 */
export function collectResponsesOutputText(
  responseBody: Record<string, unknown>,
): string {
  if (typeof responseBody.output_text === "string") return responseBody.output_text;
  const output = responseBody.output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    if (it.type !== "message" || !Array.isArray(it.content)) continue;
    for (const block of it.content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "output_text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("");
}
