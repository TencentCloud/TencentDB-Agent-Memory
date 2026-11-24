import { describe, expect, it } from "vitest";

import {
  createSseModelMaskStream,
  maskJsonText,
  maskResponseModel,
} from "../response-model-mask.js";

describe("maskJsonText", () => {
  it("rewrites a top-level model field", () => {
    expect(JSON.parse(maskJsonText('{"model":"upstream-1","id":"x"}', "client-model")))
      .toEqual({ model: "client-model", id: "x" });
  });

  it("rewrites Anthropic message_start payloads", () => {
    const input = '{"type":"message_start","message":{"model":"upstream-1"}}';
    expect(JSON.parse(maskJsonText(input, "client-model")))
      .toEqual({ type: "message_start", message: { model: "client-model" } });
  });

  it("returns text without a model field unchanged", () => {
    expect(maskJsonText('{"id":"x"}', "client-model")).toBe('{"id":"x"}');
  });

  it("returns malformed JSON unchanged", () => {
    expect(maskJsonText('{"model":', "client-model")).toBe('{"model":');
  });

  it("returns the original text when the model already matches", () => {
    const input = '{"model":"client-model"}';
    expect(maskJsonText(input, "client-model")).toBe(input);
  });
});

describe("maskResponseModel", () => {
  it("leaves a response without a body untouched", async () => {
    const resp = new Response(null, { status: 204 });
    expect(await maskResponseModel(resp, "client-model")).toBe(resp);
  });

  it("leaves non-JSON responses untouched", async () => {
    const resp = new Response("plain text", {
      headers: { "content-type": "text/plain" },
    });
    expect(await maskResponseModel(resp, "client-model")).toBe(resp);
  });

  it("rewrites JSON bodies and drops content-length", async () => {
    const resp = new Response('{"model":"upstream-1"}', {
      headers: { "content-type": "application/json", "content-length": "22" },
    });
    const out = await maskResponseModel(resp, "client-model");
    expect(out.headers.has("content-length")).toBe(false);
    expect(await out.json()).toEqual({ model: "client-model" });
  });
});

/** Emit each part as its own chunk so the transform sees a split event. */
function chunkedStream(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < parts.length) {
        controller.enqueue(encoder.encode(parts[index]));
        index += 1;
      } else {
        controller.close();
      }
    },
  });
}

describe("createSseModelMaskStream", () => {
  it("rewrites model fields and preserves SSE framing for a single chunk", async () => {
    const sse = 'data: {"model":"upstream-1"}\n\ndata: [DONE]\n\n';
    const stream = new Blob([sse]).stream()
      .pipeThrough(createSseModelMaskStream("client-model"));
    const out = await new Response(stream).text();
    expect(out).toBe('data: {"model":"client-model"}\n\ndata: [DONE]\n\n');
  });

  it("reassembles a data line split across chunks before rewriting", async () => {
    const stream = chunkedStream([
      'data: {"mod',
      'el":"upstream-1"}\n\ndata: [DONE]\n\n',
    ]).pipeThrough(createSseModelMaskStream("client-model"));
    const out = await new Response(stream).text();
    expect(out).toBe('data: {"model":"client-model"}\n\ndata: [DONE]\n\n');
  });

  it("keeps CRLF event boundaries while reassembling across chunks", async () => {
    const stream = chunkedStream([
      'data: {"model":"up',
      'stream-1"}\r\n\r\ndata: [DONE]\r\n\r\n',
    ]).pipeThrough(createSseModelMaskStream("client-model"));
    const out = await new Response(stream).text();
    expect(out).toBe('data: {"model":"client-model"}\r\n\r\ndata: [DONE]\r\n\r\n');
  });
});
