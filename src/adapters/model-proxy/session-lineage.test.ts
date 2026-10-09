import { describe, expect, it } from "vitest";

import { SessionLineage } from "./session-lineage.js";
import type { ChatMessage } from "./types.js";

describe("SessionLineage", () => {
  it("keeps continuations together and separates branches", () => {
    const lineage = new SessionLineage({ secret: "test-secret" });
    const first: ChatMessage[] = [
      { role: "system", content: "helpful" },
      { role: "user", content: "first" },
    ];
    const firstResolution = lineage.resolve(first, { namespace: "client-a" });
    lineage.commitAssistant(firstResolution, {
      role: "assistant",
      content: "first answer",
    });

    const continuation: ChatMessage[] = [
      ...first,
      { role: "assistant", content: "first answer" },
      { role: "user", content: "continue A" },
    ];
    const continued = lineage.resolve(continuation, { namespace: "client-a" });
    expect(continued.sessionKey).toBe(firstResolution.sessionKey);
    expect(continued.forked).toBe(false);

    const branch: ChatMessage[] = [
      ...first,
      { role: "assistant", content: "first answer" },
      { role: "user", content: "continue B" },
    ];
    const forked = lineage.resolve(branch, { namespace: "client-a" });
    expect(forked.sessionKey).not.toBe(firstResolution.sessionKey);
    expect(forked.forked).toBe(true);
  });

  it("isolates identical transcripts across client namespaces", () => {
    const lineage = new SessionLineage({ secret: "test-secret" });
    const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
    const first = lineage.resolve(messages, { namespace: "client-a" });
    const second = lineage.resolve(messages, { namespace: "client-b" });
    expect(first.sessionKey).not.toBe(second.sessionKey);
  });

  it("honors an explicit session key", () => {
    const lineage = new SessionLineage({ secret: "test-secret" });
    const resolution = lineage.resolve(
      [{ role: "user", content: "hello" }],
      { namespace: "client-a", explicitSessionKey: "host-session-42" },
    );
    expect(resolution.sessionKey).toBe("host-session-42");
  });
});
