import { describe, expect, it } from "vitest";

import { buildGatewayCaptureTurn } from "./capture-request.js";

describe("buildGatewayCaptureTurn", () => {
  it("adds timestamps when HTTP clients omit raw messages", () => {
    const turn = buildGatewayCaptureTurn({
      user_content: "remember the Hermes issue marker",
      assistant_content: "acknowledged",
      session_key: "capture-session-1",
    }, 1_000);

    expect(turn.startedAt).toBe(1_000);
    expect(turn.messages).toEqual([
      { role: "user", content: "remember the Hermes issue marker", timestamp: 1_001 },
      { role: "assistant", content: "acknowledged", timestamp: 1_002 },
    ]);
  });

  it("keeps synthetic timestamps increasing across rapid lightweight turns", () => {
    const first = buildGatewayCaptureTurn({
      user_content: "first user",
      assistant_content: "first assistant",
      session_key: "rapid-session",
    }, 2_000);
    const second = buildGatewayCaptureTurn({
      user_content: "second user",
      assistant_content: "second assistant",
      session_key: "rapid-session",
    }, 2_000);

    const firstAssistant = first.messages[1] as { timestamp: number };
    const secondUser = second.messages[0] as { timestamp: number };
    const secondAssistant = second.messages[1] as { timestamp: number };

    expect(secondUser.timestamp).toBeGreaterThan(firstAssistant.timestamp);
    expect(secondAssistant.timestamp).toBeGreaterThan(secondUser.timestamp);
  });

  it("continues synthetic timestamps after client-provided messages in the same session", () => {
    buildGatewayCaptureTurn({
      user_content: "fallback user",
      assistant_content: "fallback assistant",
      session_key: "mixed-session",
      messages: [
        { role: "user", content: "raw user", timestamp: 20_000 },
        { role: "assistant", content: "raw assistant", timestamp: 20_100 },
      ],
    }, 2_000);

    const next = buildGatewayCaptureTurn({
      user_content: "lightweight user",
      assistant_content: "lightweight assistant",
      session_key: "mixed-session",
    }, 2_000);

    const user = next.messages[0] as { timestamp: number };
    const assistant = next.messages[1] as { timestamp: number };

    expect(user.timestamp).toBe(20_101);
    expect(assistant.timestamp).toBe(20_102);
  });

  it("sets raw-message capture start before the payload timestamps", () => {
    const messages = [
      { role: "user", content: "original", timestamp: 2_000 },
      { role: "assistant", content: "reply", timestamp: 2_100 },
    ];

    const turn = buildGatewayCaptureTurn({
      user_content: "fallback user",
      assistant_content: "fallback assistant",
      session_key: "raw-session",
      messages,
    }, 5_000);

    expect(turn.startedAt).toBe(1_999);
    expect(turn.messages).toBe(messages);
  });

  it("uses a pre-request start time for raw messages without timestamps", () => {
    const messages = [
      { role: "user", content: "original" },
      { role: "assistant", content: "reply" },
    ];

    const turn = buildGatewayCaptureTurn({
      user_content: "fallback user",
      assistant_content: "fallback assistant",
      session_key: "raw-without-timestamp-session",
      messages,
    }, 5_000);

    expect(turn.startedAt).toBe(4_999);
    expect(turn.messages).toBe(messages);
  });
});
