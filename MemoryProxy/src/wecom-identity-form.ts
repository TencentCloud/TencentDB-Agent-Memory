import type { ProxyConfig } from "./types.js";
import { resolveWecomName, saveWecomName } from "./wecom-identity.js";
import { log } from "./report/log.js";

export const WECOM_NAME_TOOL = "tdai_set_wecom_name";
export const WECOM_NAME_CALL_ID = "call_tdai_wecom_name";
const CLAUDE_ASK_USER_QUESTION_TOOL = "AskUserQuestion";
const CANCEL_ANSWERS = new Set(["暂不填写", "暂不填写并退出", "取消本次请求"]);
// Match the session-init fake form so Anthropic-compatible thinking models
// accept the synthetic assistant turn when Claude Code sends it back.
const THINKING_SIGNATURE_PLACEHOLDER =
  "UHJveHlDQ1Nlc3Npb25Jbml0RmFrZVRoaW5raW5nUGxhY2Vob2xkZXJTaWc=";

type WireProtocol = "openai" | "anthropic" | "responses";

/** Only explicit /<agent>/... routes participate in name collection. */
export function hasExplicitAgentName(requestPath: string): boolean {
  const first = requestPath.split("/").filter(Boolean)[0];
  return Boolean(first && !new Set([
    "v1", "proxy", "direct", "skill-bridge", "memory-bridge",
  ]).has(first));
}

export type WecomIdentityResolution =
  | { kind: "resolved"; name: string }
  | { kind: "intercept"; response: Response }
  | { kind: "rejected"; response: Response };

interface SubmittedName {
  value: string;
  source: "tool_call" | "anthropic_tool_result" | "user_xml" | "responses_tool_result";
  raw?: string;
}

function asText(value: unknown): string {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return "";
    // Claude Code's AskUserQuestion returns {answers:{question:answer}} in
    // several versions. Do not use the full JSON envelope as a user name.
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== text) {
        const extracted = asText(parsed);
        if (extracted) return extracted;
      }
    } catch {
      // Text-format fallback below.
    }
    // CodeBuddy ask_followup_question result.
    const codebuddyAnswer = text.match(
      /<question_item\s+id=["']wecom_name["'][^>]*>[\s\S]*?<answers>\s*([\s\S]*?)\s*<\/answers>/i,
    ) ?? text.match(/<answers>\s*([^<]+?)\s*<\/answers>/i);
    if (codebuddyAnswer?.[1]?.trim()) return codebuddyAnswer[1].trim();
    // Other native tool wrappers.
    const xmlAnswer = text.match(/<(?:agent_)?answer[^>]*>([\s\S]*?)<\//i);
    if (xmlAnswer?.[1]?.trim()) return xmlAnswer[1].trim();
    // Alternate Claude Code result: `..."question"="answer".`
    const equalsAnswer = text.match(/="([^"]+)"[^"]*$/);
    if (equalsAnswer?.[1]?.trim()) return equalsAnswer[1].trim();
    return text;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = asText(item);
      if (text) return text;
    }
    return "";
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["wecomName", "wecom_name", "name", "answer", "text", "output"]) {
      const extracted = asText(obj[key]);
      if (extracted) return extracted;
    }
    if (obj.answers && typeof obj.answers === "object") {
      for (const answer of Object.values(obj.answers as Record<string, unknown>)) {
        const extracted = asText(answer);
        if (extracted) return extracted;
      }
    }
    if (Array.isArray(obj.questions)) {
      for (const question of obj.questions) {
        if (!question || typeof question !== "object") continue;
        const q = question as Record<string, unknown>;
        for (const key of ["answer", "answers", "selected", "selectedOption", "value"]) {
          const extracted = asText(q[key]);
          if (extracted) return extracted;
        }
      }
    }
  }
  return "";
}

/** Extract the answer only from our own tool/call ID, never arbitrary messages. */
function submittedName(body: Record<string, unknown>): SubmittedName | null {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  // Tool loops retain all previous assistant/tool messages. The newest answer
  // is authoritative; reading from the beginning can accidentally select the
  // original form envelope instead of the user's later CodeBuddy response.
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== "object") continue;
    const msg = message as Record<string, unknown>;
    if (msg.tool_call_id === WECOM_NAME_CALL_ID) {
      const raw = typeof msg.content === "string" ? msg.content : undefined;
      // A rejected CodeBuddy tool invocation is not the user's name. Treat it
      // as no answer so the corrected form can be emitted again.
      if (raw && /^Error calling tool:\s*Tool call arguments/i.test(raw.trim())) return null;
      return { value: asText(msg.content) || "", source: "tool_call", raw };
    }
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const item = block as Record<string, unknown>;
      if (item.tool_use_id === WECOM_NAME_CALL_ID) {
        return {
          value: asText(item.content) || "",
          source: "anthropic_tool_result",
          raw: typeof item.content === "string" ? item.content : undefined,
        };
      }
    }
    // Some CodeBuddy versions replay the native Q&A XML in a user message
    // without the call id. Only our own question id is accepted, so a
    // team-memory session-init answer is never consumed here.
    if (msg.role === "user" && typeof msg.content === "string"
      && /<question_item\s+id=["']wecom_name["']/i.test(msg.content)) {
      const answer = asText(msg.content);
      if (answer) return { value: answer, source: "user_xml", raw: msg.content };
    }
  }
  const input = Array.isArray(body.input) ? body.input : [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    if (value.call_id === WECOM_NAME_CALL_ID || value.id === WECOM_NAME_CALL_ID) {
      return {
        value: asText(value.output ?? value.content ?? value.arguments) || "",
        source: "responses_tool_result",
      };
    }
  }
  return null;
}

function errorResponse(protocol: WireProtocol, message: string): Response {
  const body = protocol === "anthropic"
    ? { type: "error", error: { type: "invalid_request_error", message } }
    : { error: { type: "invalid_request_error", message, code: "wecom_name_required" } };
  return new Response(JSON.stringify(body), {
    status: 428,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function formResponse(protocol: WireProtocol, stream = false): Response {
  const question = "请填写自己的企业微信名称（必填）。";
  if (protocol === "anthropic") {
    const msgId = `msg_tdai_wecom_name_${Date.now()}`;
    const inputJson = JSON.stringify({
      questions: [{
        question,
        header: "企业微信名称",
        // Claude Code requires at least two options. Its third, automatic
        // "Other" entry is the only accepted path for a name.
        options: [
          { label: "暂不填写并退出", description: "如需填写，请在第三栏 Type something 输入企业微信名称" },
          { label: "取消本次请求", description: "如需填写，请在第三栏 Type something 输入企业微信名称" },
        ],
        multiSelect: false,
      }],
    });
    const encoder = new TextEncoder();
    const sse = (event: string, data: unknown) =>
      encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sse("message_start", {
          type: "message_start",
          message: {
            id: msgId, type: "message", role: "assistant", model: "proxy",
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }));
        controller.enqueue(sse("content_block_start", {
          type: "content_block_start", index: 0,
          content_block: { type: "thinking", thinking: "" },
        }));
        controller.enqueue(sse("content_block_delta", {
          type: "content_block_delta", index: 0,
          delta: { type: "thinking_delta", thinking: "" },
        }));
        controller.enqueue(sse("content_block_delta", {
          type: "content_block_delta", index: 0,
          delta: { type: "signature_delta", signature: THINKING_SIGNATURE_PLACEHOLDER },
        }));
        controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
        controller.enqueue(sse("content_block_start", {
          type: "content_block_start", index: 1,
          content_block: {
            type: "tool_use", id: WECOM_NAME_CALL_ID,
            name: CLAUDE_ASK_USER_QUESTION_TOOL, input: {},
          },
        }));
        controller.enqueue(sse("content_block_delta", {
          type: "content_block_delta", index: 1,
          delta: { type: "input_json_delta", partial_json: inputJson },
        }));
        controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 1 }));
        controller.enqueue(sse("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 0 },
        }));
        controller.enqueue(sse("message_stop", { type: "message_stop" }));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }
  if (protocol === "responses") {
    return new Response(JSON.stringify({
      id: WECOM_NAME_CALL_ID,
      object: "response",
      status: "completed",
      output: [{
        type: "function_call",
        id: WECOM_NAME_CALL_ID,
        call_id: WECOM_NAME_CALL_ID,
        name: WECOM_NAME_TOOL,
        arguments: JSON.stringify({ question, required: true }),
      }],
    }), { headers: { "content-type": "application/json" } });
  }
  // CodeBuddy's native interactive tool. A custom function call is displayed
  // as an empty assistant answer by CodeBuddy instead of an input widget.
  const id = `wecom-name-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const args = {
    title: "企业微信名称",
    // Current CodeBuddy validates this as an array. The legacy session-init
    // form serialises questions as a string, which CodeBuddy rejects with
    // "expected array, received string".
    questions: [{
      id: "wecom_name",
      question,
      options: ["暂不填写并退出", "取消本次请求"],
      multiSelect: false,
    }],
  };
  if (!stream) {
    return new Response(JSON.stringify({
      id,
      object: "chat.completion",
      created,
      model: "proxy",
      choices: [{
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: WECOM_NAME_CALL_ID,
            type: "function",
            function: { name: "ask_followup_question", arguments: JSON.stringify(args) },
          }],
        },
      }],
    }), { headers: { "content-type": "application/json" } });
  }
  const encoder = new TextEncoder();
  const argsText = JSON.stringify(args);
  const sse = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
  const responseStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sse({
        id, object: "chat.completion.chunk", created, model: "proxy",
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [{
              index: 0, id: WECOM_NAME_CALL_ID, type: "function",
              function: { name: "ask_followup_question", arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      }));
      controller.enqueue(sse({
        id, object: "chat.completion.chunk", created, model: "proxy",
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: argsText } }] },
          finish_reason: null,
        }],
      }));
      controller.enqueue(sse({
        id, object: "chat.completion.chunk", created, model: "proxy",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      }));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(responseStream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

/**
 * Resolve the name, consume a previous form answer, or issue the native tool
 * request. CK failures deliberately reject when the feature is enabled.
 */
export async function requireWecomIdentity(
  config: ProxyConfig,
  apiKey: string,
  body: Record<string, unknown>,
  protocol: WireProtocol,
): Promise<WecomIdentityResolution> {
  if (!config.wecomIdentity?.enabled) return { kind: "resolved", name: "" };
  let known: string | null;
  try {
    known = await resolveWecomName(config, apiKey);
  } catch (error) {
    // CK is an attribution dependency, not a traffic dependency. Preserve the
    // pre-feature behaviour when it is unavailable; Opik/Langfuse fall back
    // to the existing keyId dimension for this request.
    log.warn("wecom_identity.lookup_failed_open", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: "resolved", name: "" };
  }
  if (known) return { kind: "resolved", name: known };

  const submitted = submittedName(body);
  if (submitted === null) return { kind: "intercept", response: formResponse(protocol, body.stream === true) };
  const name = submitted.value.trim().replace(/\s+/g, " ");
  const maxNameLength = config.wecomIdentity.maxNameLength;
  log.info("wecom_identity.answer_received", {
    source: submitted.source,
    answerLength: name.length,
    maxNameLength,
  });
  // AskUserQuestion requires options. Claude Code's third, automatic Other
  // input is required to submit the actual name.
  if (CANCEL_ANSWERS.has(name.toLowerCase())) {
    return {
      kind: "rejected",
      response: errorResponse(protocol, "已取消本次请求：企业微信名称未填写"),
    };
  }
  if (!name || name.length > maxNameLength) {
    if (!name) {
      // Claude Code emits an empty tool result after an invalid/cancelled
      // widget. Reissue the form rather than converting it into a terminal
      // 428, so the user still gets an input field.
      return { kind: "intercept", response: formResponse(protocol, body.stream === true) };
    }
    log.warn("wecom_identity.answer_too_long", {
      source: submitted.source,
      answerLength: name.length,
      maxNameLength,
      rawLength: submitted.raw?.length ?? 0,
      rawShape: submitted.raw
        ? {
            json: submitted.raw.trim().startsWith("{"),
            questionAnswer: submitted.raw.includes("<question_answer"),
            questionItem: submitted.raw.includes("<question_item"),
            answersTag: submitted.raw.includes("<answers>"),
            answerTag: submitted.raw.includes("<answer>"),
          }
        : undefined,
      // This diagnostic is emitted only for rejected input and capped to
      // avoid dumping the full conversation. Remove after format confirmation.
      rawPreview: submitted.raw?.slice(0, 256),
    });
    return {
      kind: "rejected",
      response: errorResponse(protocol, `企业微信名称不能超过 ${maxNameLength} 个字符`),
    };
  }
  try {
    return { kind: "resolved", name: await saveWecomName(config, apiKey, name) };
  } catch (error) {
    // The user did provide a valid name. Use it for this request even when CK
    // cannot persist it; a later request will retry the normal CK lookup.
    log.warn("wecom_identity.save_failed_open", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: "resolved", name };
  }
}
