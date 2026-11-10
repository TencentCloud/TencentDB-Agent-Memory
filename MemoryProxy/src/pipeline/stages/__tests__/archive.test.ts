import { beforeEach, expect, it, vi } from "vitest";
import type { ArchiveStageInput } from "../archive.js";

vi.mock("../../../extraction-gate.js", () => ({
  isExtractionAllowed: (_config: unknown, kind: string) => kind === "tdai-memory",
  logExtractionSkipped: vi.fn(),
}));
vi.mock("../../../skill/handler-glue.js", () => ({ triggerSkillExtractIfReady: vi.fn() }));

import { stageArchive } from "../archive.js";
import { flushPendingWrites } from "../../../tdai/pending-writes.js";
import { extractNewCodexUserMessage } from "../../../tdai/codex-recorder.js";
const addConversation = vi.fn().mockResolvedValue(undefined);
const base = {
  config: {}, sessionKey: "session", agentSource: "codex", inputMessages: [],
  assistant: { text: "new reply", raw: null }, protocol: "responses",
  tdaiClient: { addConversation },
  tdaiIdentity: { teamId: "team", userId: "user", agentId: "agent", sessionId: "session" },
  isAuxiliary: false, dshHeadless: false,
} as unknown as ArchiveStageInput;

beforeEach(() => addConversation.mockClear());

it("preserves assistant-only Codex continuations", async () => {
  await stageArchive({ ...base, tdaiAllowAssistantOnly: true });
  expect(addConversation).toHaveBeenCalledWith(base.tdaiIdentity, [{ role: "assistant", content: "new reply" }]);
});

it("preserves the existing user-message gate for other callers", async () => {
  await stageArchive(base);
  expect(addConversation).not.toHaveBeenCalled();
});

it("does not write empty tool-only continuations", async () => {
  await stageArchive({ ...base, tdaiAllowAssistantOnly: true, assistant: { text: " ", raw: null } });
  expect(addConversation).not.toHaveBeenCalled();
});

it.each(["isAuxiliary", "dshHeadless"] as const)("skips %s", async (flag) => {
  await stageArchive({ ...base, tdaiAllowAssistantOnly: true, [flag]: true });
  expect(addConversation).not.toHaveBeenCalled();
});

it("writes the user once through the streaming archive path and keeps continuation replies", async () => {
  const question = { type: "message", role: "user", content: [{ type: "input_text", text: "show code" }] };
  const history: unknown[] = [question];
  for (const text of ["checking", "", "finished"]) {
    await stageArchive({
      ...base, inputMessages: history, tdaiAllowAssistantOnly: true,
      tdaiWriteMode: "fire-and-forget-tracked",
      tdaiUserMessage: extractNewCodexUserMessage(history) ?? undefined,
      assistant: { text, raw: null },
    });
    history.push({ type: "custom_tool_call_output", output: "result" });
  }
  await flushPendingWrites(100);
  expect(addConversation.mock.calls.flatMap((call) => call[1])).toEqual([
    { role: "user", content: "show code" },
    { role: "assistant", content: "checking" },
    { role: "assistant", content: "finished" },
  ]);
});
