import { describe, it, expect, vi } from "vitest";
import { renderSessionInitPicker } from "../picker.js";
import type { SessionInitForm } from "../form.js";
import { Key } from "@earendil-works/pi-tui";

// The real matchesKey compares against legacy byte sequences. We feed those
// same bytes so the test exercises the real input-handling path:
//   Enter = "\r", Up = "\x1b[A", Down = "\x1b[B", Esc = "\x1b".
const ENTER = "\r";
const DOWN = "\x1b[B";

// A stub ctx.ui.custom that drives the factory's component with canned keys.
// Each question's menu is a separate custom() call; keySeqs is consumed
// across calls in order.
function makeCtx(keySeqsPerQuestion: string[][]) {
  let qIdx = 0;
  const ctx: any = {
    mode: "tui",
    hasUI: true,
    ui: {
      custom<T>(factory: any): Promise<T | null> {
        return new Promise((resolve) => {
          const comp = factory(
            { requestRender: () => {} }, // tui
            { fg: (_c: string, s: string) => s, bold: (s: string) => s }, // theme
            {}, // keybindings
            (result: T | null) => resolve(result),
          );
          for (const k of keySeqsPerQuestion[qIdx] ?? []) comp.handleInput(k);
          qIdx++;
        });
      },
    },
  };
  return ctx;
}

const twoQ: SessionInitForm = {
  title: "Pick",
  questions: [
    { id: "agent", question: "Agent?", options: ["Lucius Fox (0b0wybln)", "Other (ao5f94a7)"], multiSelect: false },
    { id: "task", question: "Task?", options: ["Pi adapter development (hnrorewx)"], multiSelect: false },
  ],
};

describe("renderSessionInitPicker", () => {
  it("picks the first option of each question with Enter", async () => {
    const ctx = makeCtx([[ENTER], [ENTER]]);
    const ans = await renderSessionInitPicker(ctx, twoQ);
    expect(ans).toEqual([
      { id: "agent", answer: "Lucius Fox (0b0wybln)" },
      { id: "task", answer: "Pi adapter development (hnrorewx)" },
    ]);
  });
  it("picks the second option with Down then Enter", async () => {
    const ctx = makeCtx([[DOWN, ENTER], [ENTER]]);
    const ans = await renderSessionInitPicker(ctx, twoQ);
    expect(ans?.[0]).toEqual({ id: "agent", answer: "Other (ao5f94a7)" });
  });
  it("returns null on Esc (cancel whole picker)", async () => {
    const ctx = makeCtx([["\x1b"]]);
    const ans = await renderSessionInitPicker(ctx, twoQ);
    expect(ans).toBeNull();
  });
  it("returns null in non-TUI mode", async () => {
    const ctx: any = { mode: "print", hasUI: false, ui: { custom: vi.fn() } };
    const ans = await renderSessionInitPicker(ctx, twoQ);
    expect(ans).toBeNull();
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });
});
