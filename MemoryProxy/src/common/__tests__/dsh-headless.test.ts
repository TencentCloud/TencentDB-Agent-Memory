import { describe, expect, it } from "vitest";
import { isDshHeadlessNoPreset, isDshPtcPresentation } from "../dsh-headless.js";

/** OpenAI chat-completions tool entry, the shape dsh puts on the wire. */
function fnTool(name: string): { type: "function"; function: { name: string } } {
  return { type: "function", function: { name } };
}

describe("isDshHeadlessNoPreset", () => {
  it("does not treat a dsh PTC request whose only wire tool is run_code as headless", () => {
    // Production break: returning true here sets injectedSkipped and skips
    // session-init for every PTC turn (issue 1377).
    const body = { tools: [fnTool("run_code")] };
    expect(isDshPtcPresentation("dsh", body)).toBe(true);
    expect(isDshHeadlessNoPreset("dsh", body)).toBe(false);
  });

  it("accepts the flat {name} tool shape as the same PTC presentation", () => {
    const body = { tools: [{ name: "run_code" }] };
    expect(isDshPtcPresentation("dsh", body)).toBe(true);
    expect(isDshHeadlessNoPreset("dsh", body)).toBe(false);
  });

  it("treats a wire list whose only named tool is run_code as PTC", () => {
    // Unnamed extras do not advertise a native tool. The callable surface
    // is still the reserved run_code transport.
    const body = { tools: [fnTool("run_code"), { note: "ignored" }, fnTool("run_code")] };
    expect(isDshPtcPresentation("dsh", body)).toBe(true);
    expect(isDshHeadlessNoPreset("dsh", body)).toBe(false);
  });

  it("keeps a non-empty custom tool list without ask_user_question on the headless bypass", () => {
    // Production break: returning false here would pop a fake ask_user_question
    // tool_call at a CLI / API client that has no form tool.
    const body = { tools: [fnTool("bash"), fnTool("read_file")] };
    expect(isDshPtcPresentation("dsh", body)).toBe(false);
    expect(isDshHeadlessNoPreset("dsh", body)).toBe(true);
  });

  it("keeps run_code plus any other named tool on the headless bypass when ask_user_question is absent", () => {
    const body = { tools: [fnTool("run_code"), fnTool("bash")] };
    expect(isDshPtcPresentation("dsh", body)).toBe(false);
    expect(isDshHeadlessNoPreset("dsh", body)).toBe(true);
  });

  it("does not bypass when the standard preset advertises ask_user_question", () => {
    const body = { tools: [fnTool("bash"), fnTool("ask_user_question"), fnTool("read_file")] };
    expect(isDshPtcPresentation("dsh", body)).toBe(false);
    expect(isDshHeadlessNoPreset("dsh", body)).toBe(false);
  });

  it("does not treat mode:both (run_code and ask_user_question together) as PTC or headless", () => {
    const body = { tools: [fnTool("run_code"), fnTool("ask_user_question"), fnTool("bash")] };
    expect(isDshPtcPresentation("dsh", body)).toBe(false);
    expect(isDshHeadlessNoPreset("dsh", body)).toBe(false);
  });

  it("prefers function.name over a flat name when both are present", () => {
    const headlessBody = { tools: [{ name: "ask_user_question", function: { name: "bash" } }] };
    expect(isDshHeadlessNoPreset("dsh", headlessBody)).toBe(true);
    const interactiveBody = { tools: [{ name: "bash", function: { name: "ask_user_question" } }] };
    expect(isDshHeadlessNoPreset("dsh", interactiveBody)).toBe(false);
  });

  it("does not let an empty function.name fall through to a flat ask_user_question", () => {
    // Historical `function.name ?? name`: "" is not nullish, so the flat
    // ask tool is ignored and the request stays on the headless bypass.
    const body = { tools: [{ name: "ask_user_question", function: { name: "" } }] };
    expect(isDshHeadlessNoPreset("dsh", body)).toBe(true);
    expect(isDshPtcPresentation("dsh", body)).toBe(false);
  });

  it("does not bypass an empty or missing tools list", () => {
    expect(isDshHeadlessNoPreset("dsh", { tools: [] })).toBe(false);
    expect(isDshPtcPresentation("dsh", { tools: [] })).toBe(false);
    expect(isDshHeadlessNoPreset("dsh", {})).toBe(false);
    expect(isDshHeadlessNoPreset("dsh", { tools: "run_code" })).toBe(false);
    expect(isDshHeadlessNoPreset("dsh", null)).toBe(false);
  });

  it("still bypasses a non-empty tools list that advertises no names and no ask_user_question", () => {
    const body = { tools: [{}] };
    expect(isDshPtcPresentation("dsh", body)).toBe(false);
    expect(isDshHeadlessNoPreset("dsh", body)).toBe(true);
  });

  it("ignores the PTC shape for every other agent", () => {
    const body = { tools: [fnTool("run_code")] };
    expect(isDshPtcPresentation("codebuddy", body)).toBe(false);
    expect(isDshHeadlessNoPreset("codebuddy", body)).toBe(false);
    expect(isDshHeadlessNoPreset("claude-code", body)).toBe(false);
  });
});
