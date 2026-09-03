import { describe, expect, it } from "vitest";
import { dshAdapter, dshCanRenderInteractiveForm } from "../dsh.js";

describe("dshAdapter.extractUserText", () => {
  it("filters both forms of runtime-context metadata", () => {
    expect(dshAdapter.extractUserText("Current runtime context. cwd=/work")).toBeNull();
    expect(dshAdapter.extractUserText(
      "Current runtime context: none. Earlier runtime-context snapshots no longer apply.",
    )).toBeNull();
  });

  it("extracts text from a multimodal dsh user message", () => {
    expect(dshAdapter.extractUserText([
      { type: "text", text: "请分析这张截图" },
      { type: "file", file_id: "file-1" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ])).toBe("请分析这张截图");
  });

  it("drops non-text-only multimodal content", () => {
    expect(dshAdapter.extractUserText([{ type: "file", file_id: "file-1" }])).toBeNull();
  });
});

describe("dshCanRenderInteractiveForm", () => {
  it("requires the ask_user_question tool", () => {
    expect(dshCanRenderInteractiveForm({ tools: [
      { type: "function", function: { name: "ask_user_question" } },
    ] })).toBe(true);
    expect(dshCanRenderInteractiveForm({ tools: [
      { type: "function", function: { name: "bash" } },
    ] })).toBe(false);
    expect(dshCanRenderInteractiveForm({})).toBe(false);
  });
});
