import { describe, expect, it } from "vitest";

import { BasePlatformAdapter, defineAdapter } from "./platform-adapter.js";

describe("BasePlatformAdapter defaults (Whale shape)", () => {
  const adapter = new BasePlatformAdapter({ name: "test" });

  it("parses recall payloads from prompt/session_id", () => {
    expect(adapter.parseRecallPayload({ prompt: "hi", session_id: "s1" })).toEqual({
      query: "hi",
      sessionKey: "s1",
    });
  });

  it("returns null for recall payloads without a prompt", () => {
    expect(adapter.parseRecallPayload({})).toBeNull();
    expect(adapter.parseRecallPayload({ prompt: "" })).toBeNull();
    expect(adapter.parseRecallPayload({ prompt: 42 })).toBeNull();
  });

  it("parses capture payloads from prompt/last_assistant_text", () => {
    expect(
      adapter.parseCapturePayload({ prompt: "u", last_assistant_text: "a", session_id: "s" }),
    ).toEqual({ userContent: "u", assistantContent: "a", sessionKey: "s" });
  });

  it("returns null for capture payloads with neither side of the turn", () => {
    expect(adapter.parseCapturePayload({})).toBeNull();
    expect(adapter.parseCapturePayload({ prompt: "", last_assistant_text: "" })).toBeNull();
  });

  it("formats recall output as Whale-style decision/additional_context", () => {
    const out = JSON.parse(adapter.formatRecallOutput("remembered stuff", {}));
    expect(out).toEqual({
      decision: "pass",
      additional_context: "## Memory Context\nremembered stuff",
    });
  });

  it("extracts sessionKey from session_id (empty string fallback)", () => {
    expect(adapter.sessionKeyFrom({ session_id: "s7" })).toBe("s7");
    expect(adapter.sessionKeyFrom({})).toBe("");
  });
});

describe("defineAdapter descriptor overrides", () => {
  it("routes every hook point through the descriptor", async () => {
    const adapter = defineAdapter({
      name: "custom",
      parseRecallPayload: (p: any) => ({ query: p.q, sessionKey: p.sid }),
      parseCapturePayload: async (p: any) => ({
        userContent: p.u,
        assistantContent: p.a,
        sessionKey: p.sid,
      }),
      formatRecallOutput: (context) => JSON.stringify({ inject: context }),
      sessionKeyFrom: (p: any) => p.sid ?? "",
    });

    expect(adapter.name).toBe("custom");
    expect(adapter.parseRecallPayload({ q: "x", sid: "s" })).toEqual({ query: "x", sessionKey: "s" });
    await expect(adapter.parseCapturePayload({ u: "1", a: "2", sid: "s" })).resolves.toEqual({
      userContent: "1",
      assistantContent: "2",
      sessionKey: "s",
    });
    expect(JSON.parse(adapter.formatRecallOutput("ctx", {}))).toEqual({ inject: "ctx" });
    expect(adapter.sessionKeyFrom({ sid: "s3" })).toBe("s3");
  });

  it("keeps defaults for omitted descriptor methods", () => {
    const adapter = defineAdapter({
      name: "partial",
      formatRecallOutput: (context) => JSON.stringify({ custom: context }),
    });
    // Overridden:
    expect(JSON.parse(adapter.formatRecallOutput("c", {}))).toEqual({ custom: "c" });
    // Default:
    expect(adapter.parseRecallPayload({ prompt: "p", session_id: "s" })).toEqual({
      query: "p",
      sessionKey: "s",
    });
  });
});
