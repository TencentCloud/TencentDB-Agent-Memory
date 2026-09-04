import { describe, expect, it } from "vitest";

import { SessionStore } from "../store.js";

describe("SessionStore", () => {
  it("treats a first dsh request with loaded skill content as a new session", async () => {
    const store = new SessionStore();

    const state = await store.getOrRecover(
      "dsh:session-1",
      {
        userId: "user-1",
        agentSource: "dsh",
        sessionId: "session-1",
      },
      {
        messages: [
          { role: "user", content: "/anima-prompt-v1 write a summary" },
          { role: "user", content: "Current runtime context. cwd=/workspace" },
          {
            role: "user",
            content: "<system-reminder>\nA skill is a reusable instruction set.",
          },
          {
            role: "user",
            content: '<skill_content name="anima-prompt-v1">Use a concise style.</skill_content>',
          },
        ],
      },
    );

    expect(state).toBeUndefined();
  });
});
