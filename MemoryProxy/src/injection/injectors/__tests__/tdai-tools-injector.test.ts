import { describe, expect, it } from "vitest";
import { renderTdaiMemoryToolsBlock } from "../tdai-tools-injector.js";

describe("memory tool guidance", () => {
  it("prefers existing native tools without removing the curl fallback or memory limits", () => {
    const block = renderTdaiMemoryToolsBlock("http://127.0.0.1:8096", "pi-synthetic", "default");
    expect(block).toContain("优先使用同名原生工具");
    expect(block).toContain("不要重复执行 curl");
    expect(block).toContain("未提供原生工具时使用下面的 curl 命令");
    expect(block).toContain("curl -sfk -X POST http://127.0.0.1:8096/memory-bridge/v3/atomic/search");
    expect(block).toContain("x-conversation-id: pi-synthetic");
    expect(block).toContain("合计 ≤ 3 次");
    expect(block).toContain("path 必须先从");
    expect(block).toContain("L3（persona 长期画像）与 L2 场景索引");
  });
});
