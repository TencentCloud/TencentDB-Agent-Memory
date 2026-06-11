import { describe, expect, it } from "vitest";
import { EXTRACT_MEMORIES_SYSTEM_PROMPT } from "./l1-extraction.js";
import { CONFLICT_DETECTION_SYSTEM_PROMPT } from "./l1-dedup.js";

describe("L1 scoped instruction prompts", () => {
  it("tells extraction to preserve explicit instruction scope in content", () => {
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("场景限定指令");
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("必须把场景条件写入 content");
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("不得泛化成无条件全局规则");
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("在生成用于即时通讯发送的文本时尽量不要使用表格");
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("不要仅因带场景限定就低于 70");
  });

  it("tells dedup to keep distinct instruction scopes during merge/update", () => {
    expect(CONFLICT_DETECTION_SYSTEM_PROMPT).toContain("必须同时比较适用场景/条件");
    expect(CONFLICT_DETECTION_SYSTEM_PROMPT).toContain("适用场景不同");
    expect(CONFLICT_DETECTION_SYSTEM_PROMPT).toContain("不是无条件的同一全局规则");
    expect(CONFLICT_DETECTION_SYSTEM_PROMPT).toContain("merged_content 必须保留所有仍然成立的场景限定词");
    expect(CONFLICT_DETECTION_SYSTEM_PROMPT).toContain("不得把带条件的规则改写成无条件全局规则");
  });
});
