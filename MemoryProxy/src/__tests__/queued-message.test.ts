// Regression for #1520: Claude Code queues a message typed mid-turn and injects
// it into the next tool-result user message inside a <system-reminder> block.
// extractUserQueryText used to strip that block wholesale, so the user's
// instruction never reached L0 (recorded as tool output instead) and the L1
// recall injector got an empty query.
//
// Contract after the fix: the queued-message body is promoted to user-typed
// text before the wrapper strip runs; the CC boilerplate trailer
// ("IMPORTANT: ... Do not ignore it.") is dropped; ordinary system-reminders
// are still stripped wholesale.
import { describe, expect, it } from "vitest";
import { extractUserQueryText } from "../common/user-query-extractor.js";

const queued = (body: string) =>
  `<system-reminder>\nThe user sent a new message while you were working:\n${body}\n\nIMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.\n</system-reminder>`;

describe("#1520 queued mid-turn message is promoted to user text", () => {
  it("the report's minimal replay: queued instruction survives inside a tool-result message", () => {
    const raw = [
      "<system-reminder>",
      "The user sent a new message while you were working:",
      "Also keep the old /login endpoint working.",
      "",
      "IMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.",
      "</system-reminder>",
    ].join("\n");
    expect(extractUserQueryText(raw)).toBe("Also keep the old /login endpoint working.");
  });

  it("CC boilerplate trailer is dropped, body kept verbatim", () => {
    const out = extractUserQueryText(queued("Also add pagination to the list view."));
    expect(out).toBe("Also add pagination to the list view.");
    expect(out).not.toContain("IMPORTANT");
    expect(out).not.toContain("system-reminder");
  });

  it("ordinary system-reminders are still stripped wholesale", () => {
    const raw = "<system-reminder>Some unrelated harness note</system-reminder>";
    expect(extractUserQueryText(raw)).toBe("");
  });

  it("queued block plus real typed text: queued body wins as the user query", () => {
    const raw = "<bash-stdout>42</bash-stdout>\n" + queued("先修登录问题");
    const out = extractUserQueryText(raw);
    expect(out).toContain("先修登录问题");
    expect(out).not.toContain("42");
  });
});
