// 测试文件 - Task 2: Trae hook-handler
import { describe, it, expect, vi } from "vitest";
import { handleTraeHook } from "./hook-handler.js";
import { TdaiBridge } from "../tdai-bridge/tdai-bridge.js";

function fakeBridge(recallCtx = "RECALLED") {
  return {
    recall: vi.fn().mockResolvedValue({ context: recallCtx }),
    capture: vi.fn().mockResolvedValue({ ok: true }),
    endSession: vi.fn().mockResolvedValue(undefined),
  } as unknown as TdaiBridge;
}

describe("handleTraeHook", () => {
  it("UserPromptSubmit → recall + bounded additionalContext", async () => {
    const bridge = fakeBridge();
    const out = await handleTraeHook("UserPromptSubmit", { prompt: "how do I X" }, bridge);
    expect(bridge.recall).toHaveBeenCalledWith("how do I X", expect.any(String));
    expect(out.additionalContext).toContain("RECALLED");
  });

  it("Stop → capture(user, assistant)", async () => {
    const bridge = fakeBridge();
    await handleTraeHook("Stop", { last_assistant_message: "answer" }, bridge);
    expect(bridge.capture).toHaveBeenCalledWith(expect.objectContaining({ assistantText: "answer" }), expect.any(String));
  });

  it("SessionEnd → endSession", async () => {
    const bridge = fakeBridge();
    await handleTraeHook("SessionEnd", {}, bridge);
    expect(bridge.endSession).toHaveBeenCalled();
  });
});
