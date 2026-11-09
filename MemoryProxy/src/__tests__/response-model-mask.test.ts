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

describe("createSseModelMaskStream", () => {
  it("rewrites model fields in SSE data lines", async () => {
    const sse = 'data: {"model":"upstream-1"}\n\ndata: [DONE]\n\n';
    const stream = new Blob([sse]).stream()
      .pipeThrough(createSseModelMaskStream("client-model"));
    const out = await new Response(stream).text();
    expect(out).toContain('"model":"client-model"');
    expect(out).toContain("data: [DONE]");
  });
});
