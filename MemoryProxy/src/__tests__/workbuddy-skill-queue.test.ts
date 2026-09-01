import { describe, expect, it } from "vitest";
import { injectWorkbuddyDynamicSkills } from "../workbuddyHandler.js";
import { SKILL_QUEUE_END, SKILL_QUEUE_START } from "../common/skill-queue-markers.js";

const skill = (name: string) => `${SKILL_QUEUE_START}\n${name}\n${SKILL_QUEUE_END}`;
const message = (text: string) => ({
  type: "message", role: "user", content: [{ type: "input_text", text }],
});
const identity = (sessionId: string) => ({
  spaceId: "space", userId: "user", agentSource: "workbuddy", sessionId,
});

describe("WorkBuddy every-queue Skill history", () => {
  it("persists the same listing on each distinct queue", async () => {
    await injectWorkbuddyDynamicSkills(
      { input: [message("q1")] }, skill("mysql"), "every_queue", identity("unchanged"),
    );
    const second = await injectWorkbuddyDynamicSkills(
      { input: [message("q1"), message("q2")] },
      skill("mysql"), "every_queue", identity("unchanged"),
    );
    expect((second.input as any[])[0].content).toHaveLength(2);
    expect((second.input as any[])[1].content).toHaveLength(2);
  });

  it("appends once when the business listing changes", async () => {
    await injectWorkbuddyDynamicSkills(
      { input: [message("keyboard")] }, skill("keyboard"), "every_queue", identity("shift"),
    );
    const shifted = await injectWorkbuddyDynamicSkills(
      { input: [message("keyboard"), message("database")] },
      skill("mysql"), "every_queue", identity("shift"),
    );
    expect((shifted.input as any[])[0].content[1].text).toContain("keyboard");
    expect((shifted.input as any[])[1].content[1].text).toContain("mysql");
  });

  it("reuses exact bytes during a tool loop", async () => {
    const original = { input: [message("database")] };
    const first = await injectWorkbuddyDynamicSkills(
      original, skill("mysql"), "every_queue", identity("tool-loop"),
    );
    const replay = await injectWorkbuddyDynamicSkills(
      original, skill("mysql"), "every_queue", identity("tool-loop"),
    );
    expect((replay.input as any[])[0].content[1].text)
      .toBe((first.input as any[])[0].content[1].text);
  });

  it("latest_only removes old Proxy blocks and targets the latest queue", async () => {
    const result = await injectWorkbuddyDynamicSkills(
      { input: [message("q1"), message("q2")] },
      skill("latest"), "latest_only", identity("latest"),
    );
    expect((result.input as any[])[0].content).toHaveLength(1);
    expect((result.input as any[])[1].content[1].text).toContain("latest");
  });
});
