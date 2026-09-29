import { describe, expect, it, vi } from "vitest";
import { createAgentContext, textBlock } from "../../injection/context.js";
import { TdaiL1RecallInjector } from "../../injection/injectors/tdai-l1-recall-injector.js";
import { TdaiClient } from "../client.js";
import { extractLatestUserMessage, recordTdaiTurn } from "../recorder.js";
import type { TdaiIdentity } from "../types.js";

const notification = "<task-notification><task-id>test-task</task-id><summary>Build passed.</summary></task-notification>";
const summary = "This session is being continued from a previous conversation that ran out of context.\nSummary.";
const identity: TdaiIdentity = {
  teamId: "test-team", userId: "test-user", agentId: "test-agent", sessionId: "test-session",
};

function createClient(): TdaiClient {
  return new TdaiClient({
    enabled: true, endpoint: "http://127.0.0.1:1", apiKey: "", serviceId: "test",
    writeL0: true, recallL1: true, injectL2L3: false, l1Limit: 5, l2Limit: 5, timeoutMs: 100,
  });
}

function context(texts: string[]) {
  return createAgentContext([{ role: "user", blocks: texts.map((text) => textBlock(text)) }], {}, {
    protocol: "anthropic", agentSource: "claude-code", traceId: "test", keyId: "test",
    modelId: "test", stream: false,
    custom: { session: {
      team_id: identity.teamId, user_id: identity.userId,
      agent_id: identity.agentId, session_id: identity.sessionId,
    } },
  });
}

describe("Claude Code harness input at the L0/L1 boundaries", () => {
  it("does not write an L0 turn made entirely of notifications and command output", async () => {
    const client = createClient();
    const write = vi.spyOn(client, "addConversation").mockResolvedValue(undefined);
    const user = extractLatestUserMessage([{ role: "user", content: [
      { type: "text", text: notification },
      { type: "text", text: "<local-command-stdout>Compacted.</local-command-stdout>" },
    ] }]);
    await recordTdaiTurn(client, identity, user, "Task acknowledged.");
    expect(user).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps real user text from mixed Anthropic content blocks when writing L0", async () => {
    const client = createClient();
    const write = vi.spyOn(client, "addConversation").mockResolvedValue(undefined);
    const user = extractLatestUserMessage([{ role: "user", content: [
      { type: "text", text: notification },
      { type: "text", text: "Please explain the failing test." },
      { type: "text", text: "<bash-stdout>Generated output</bash-stdout>" },
    ] }]);
    await recordTdaiTurn(client, identity, user, "Here is the explanation.");
    expect(write).toHaveBeenCalledWith(identity, [
      { role: "user", content: "Please explain the failing test." },
      { role: "assistant", content: "Here is the explanation." },
    ]);
  });

  // CC merges the interrupt marker and the next typed prompt into one user message.
  it("records the prompt typed after an interrupt, not the interrupted one", async () => {
    const client = createClient();
    const write = vi.spyOn(client, "addConversation").mockResolvedValue(undefined);
    const user = extractLatestUserMessage([
      { role: "user", content: "Fix the login bug." },
      { role: "assistant", content: [{ type: "text", text: "Looking into it." }] },
      { role: "user", content: [
        { type: "text", text: "[Request interrupted by user]" },
        { type: "text", text: "Only touch the Safari code path." },
      ] },
    ]);
    await recordTdaiTurn(client, identity, user, "Understood.");
    expect(write).toHaveBeenCalledWith(identity, [
      { role: "user", content: "Only touch the Safari code path." },
      { role: "assistant", content: "Understood." },
    ]);
  });

  it("records the first prompt after compaction without the summary", () => {
    expect(extractLatestUserMessage([{ role: "user", content: summary }])).toBeNull();
    expect(extractLatestUserMessage([{ role: "user", content: [
      { type: "text", text: summary },
      { type: "text", text: "Now add tests for the parser." },
    ] }])).toEqual({ role: "user", content: "Now add tests for the parser." });
  });

  it("preserves the existing backward scan past a trailing task notification", () => {
    expect(extractLatestUserMessage([
      { role: "user", content: "Run the tests." },
      { role: "assistant", content: "Running them now." },
      { role: "user", content: notification },
    ])).toEqual({ role: "user", content: "Run the tests." });
  });

  it.each([
    notification,
    summary,
    "[Request interrupted by user for tool use]",
  ])("does not issue an L1 search for harness-only input: %s", async (text) => {
    const client = createClient();
    const search = vi.spyOn(client, "searchL1ForCtx").mockResolvedValue([]);
    expect(await new TdaiL1RecallInjector(client).execute(context([text]))).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it.each([
    notification,
    summary,
    "[Request interrupted by user for tool use]",
  ])("uses only the real query for L1 recall when it follows %s", async (harness) => {
    const client = createClient();
    const search = vi.spyOn(client, "searchL1ForCtx").mockResolvedValue([]);
    await new TdaiL1RecallInjector(client).execute(context([harness, "How do we deploy this project?"]));
    expect(search).toHaveBeenCalledExactlyOnceWith(
      { teamId: identity.teamId, userId: identity.userId, agentId: identity.agentId, agentName: identity.agentId },
      "How do we deploy this project?", identity.sessionId, undefined, undefined,
    );
  });
});
