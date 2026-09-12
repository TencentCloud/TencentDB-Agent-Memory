import { describe, expect, it, vi } from "vitest";

import { CaptureOutbox } from "./capture-outbox.js";
import type { ModelProxyGateway } from "./types.js";

function createGateway(capture: ModelProxyGateway["capture"]): ModelProxyGateway {
  return {
    recall: vi.fn(async () => ({})),
    capture,
    endSession: vi.fn(async () => ({})),
  };
}

describe("CaptureOutbox", () => {
  it("deduplicates capture ids and removes successful writes", async () => {
    const capture = vi.fn(async () => ({}));
    const outbox = new CaptureOutbox({
      databasePath: ":memory:",
      gateway: createGateway(capture),
    });
    const payload = {
      user_content: "u",
      assistant_content: "a",
      session_key: "s",
    };

    outbox.enqueue("same-id", payload);
    outbox.enqueue("same-id", payload);
    await outbox.drainDue({ ignoreBackoff: true });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({
      idempotency_key: "same-id",
    }));
    expect(outbox.pendingCount()).toBe(0);
    await outbox.close();
  });

  it("retains failed writes and retries them", async () => {
    let calls = 0;
    const capture = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return {};
    });
    const outbox = new CaptureOutbox({
      databasePath: ":memory:",
      gateway: createGateway(capture),
      baseRetryMs: 60_000,
    });

    outbox.enqueue("retry-id", {
      user_content: "u",
      assistant_content: "a",
      session_key: "s",
    });
    await outbox.drainDue({ ignoreBackoff: true });
    expect(outbox.pendingCount()).toBe(1);

    await outbox.drainDue({ ignoreBackoff: true });
    expect(outbox.pendingCount()).toBe(0);
    expect(capture).toHaveBeenCalledTimes(2);
    await outbox.close();
  });
});
