import { describe, it, expect } from "vitest";
import { createResponsesSseToChatSse } from "../common/responses-chat-compat.js";

const encoder = new TextEncoder();

async function runThrough(
  transform: TransformStream<Uint8Array, Uint8Array>,
  sseText: string,
): Promise<string> {
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseText));
      controller.close();
    },
  });
  const output = input.pipeThrough(transform);
  return new Response(output).text();
}

const frame = (event: string, data: Record<string, unknown>): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe("Responses SSE 精简实现（只发 added/done、不发 delta）兜底", () => {
  it("function_call 只有 added + done：完整 arguments 与名称补发，不产生空参数", async () => {
    const sse = [
      frame("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "fc_1",
          type: "function_call",
          status: "in_progress",
          call_id: "call_1",
          name: "get_weather",
          arguments: "",
        },
      }),
      frame("response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "fc_1",
          type: "function_call",
          status: "completed",
          call_id: "call_1",
          name: "get_weather",
          arguments: '{"city":"Shanghai"}',
        },
      }),
      frame("response.completed", {
        type: "response.completed",
        response: {
          id: "resp_1",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "m",
          output: [],
        },
      }),
    ].join("");

    const out = await runThrough(createResponsesSseToChatSse({ model: "m" }), sse);
    expect(out).toContain("get_weather");
    // arguments 在 SSE 帧里是转义后的 JSON 字符串：{"city":"Shanghai"}
    expect(out).toContain("Shanghai");
    expect(out.split("Shanghai").length - 1).toBe(1);
  });

  it("message 只有 done：完整 output_text 兜底为 content delta", async () => {
    const sse = [
      frame("response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg_1",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            { type: "output_text", text: "完整回答内容", annotations: [] },
          ],
        },
      }),
      frame("response.completed", {
        type: "response.completed",
        response: {
          id: "resp_1",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "m",
          output: [],
        },
      }),
    ].join("");

    const out = await runThrough(createResponsesSseToChatSse({ model: "m" }), sse);
    expect(out).toContain("完整回答内容");
    expect(out.split("完整回答内容").length - 1).toBe(1);
  });

  it("reasoning 只有 done：summary 兜底为 reasoning_content delta", async () => {
    const sse = [
      frame("response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "rs_1",
          type: "reasoning",
          status: "completed",
          summary: [{ type: "summary_text", text: "先查数据库再回答" }],
        },
      }),
      frame("response.completed", {
        type: "response.completed",
        response: {
          id: "resp_1",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "m",
          output: [],
        },
      }),
    ].join("");

    const out = await runThrough(createResponsesSseToChatSse({ model: "m" }), sse);
    expect(out).toContain("先查数据库再回答");
  });
});
