/**
 * Tests for #762 — the memory-tools guide and Scene Navigation hint must
 * reflect which scene-detail read tool is actually registered.
 */

import { describe, expect, it } from "vitest";
import { formatRecallResult, readToolName } from "./format.js";

const l1 = [{ id: "1", content: "prefers short replies", type: "preference" }];
const scenes = [{ path: "scene_blocks/career.md" }];

describe("readToolName (#762)", () => {
  it("maps each deployment mode to the registered tool", () => {
    expect(readToolName("cos")).toBe("tdai_read_cos");
    expect(readToolName("local")).toBe("tdai_read_local");
    expect(readToolName("none")).toBeNull();
  });
});

describe("formatRecallResult readTool (#762)", () => {
  it("guides tdai_read_local in local mode (never tdai_read_cos)", () => {
    const out = formatRecallResult(l1, "Persona text", scenes, "local");
    expect(out.appendSystemContext).toContain("tdai_read_local");
    expect(out.appendSystemContext).not.toContain("tdai_read_cos");
    // Scene Navigation hint points at the local tool.
    expect(out.appendSystemContext).toContain("可使用 tdai_read_local 读取详细内容");
  });

  it("keeps tdai_read_cos guidance by default (COS mode)", () => {
    const out = formatRecallResult(l1, null, scenes); // readTool defaults to "cos"
    expect(out.appendSystemContext).toContain("tdai_read_cos");
    expect(out.appendSystemContext).not.toContain("tdai_read_local");
    expect(out.appendSystemContext).toContain("可使用 tdai_read_cos 读取详细内容");
  });

  it("omits read-tool guidance entirely when none is registered", () => {
    const out = formatRecallResult(l1, null, scenes, "none");
    expect(out.appendSystemContext).not.toContain("tdai_read_cos");
    expect(out.appendSystemContext).not.toContain("tdai_read_local");
    // Scene Navigation is still present but does not advertise a read tool.
    expect(out.appendSystemContext).toContain("Scene Navigation");
    expect(out.appendSystemContext).toContain("*以下是当前场景记忆索引。*");
  });
});
