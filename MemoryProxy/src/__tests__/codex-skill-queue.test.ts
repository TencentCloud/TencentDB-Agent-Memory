import { describe, expect, it } from "vitest";
import { injectCodexAssets, injectCodexDynamicSkills } from "../codexHandler.js";
import { SKILL_QUEUE_END, SKILL_QUEUE_START } from "../common/skill-queue-markers.js";

const skill = (name: string) => `${SKILL_QUEUE_START}\n${name}\n${SKILL_QUEUE_END}`;
const message = (role: string, text: string) => ({
  type: "message",
  role,
  content: [{ type: "input_text", text }],
});
const identity = (sessionId: string) => ({
  spaceId: "space", userId: "user", agentSource: "codex", sessionId,
});

describe("Codex dynamic Skill replay", () => {
  it("keeps static assets on the stable first message", () => {
    const body = { input: [message("developer", "system"), message("user", "q1")] };
    const result = injectCodexAssets(body, { raw: "<skill_tools>stable</skill_tools>" });
    expect((result.input as any[])[0].content[1].text).toContain("skill_tools");
    expect((result.input as any[])[1].content).toHaveLength(1);
  });

  it("reconstructs snapshots from original client history", async () => {
    const first = await injectCodexDynamicSkills(
      { input: [message("developer", "system"), message("user", "q1")] },
      skill("keyboard"), "every_queue", identity("codex-replay"),
    );
    expect((first.input as any[])[1].content[1].text).toContain("keyboard");

    // The second request replays the unmodified client history, not `first`.
    const second = await injectCodexDynamicSkills(
      { input: [message("developer", "system"), message("user", "q1"), message("user", "q2")] },
      skill("mysql"), "every_queue", identity("codex-replay"),
    );
    expect((second.input as any[])[1].content[1].text).toContain("keyboard");
    expect((second.input as any[])[2].content[1].text).toContain("mysql");
  });
});
