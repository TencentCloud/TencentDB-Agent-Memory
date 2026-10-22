import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const autoCapture = vi.hoisted(() => ({
  performAutoCapture: vi.fn(),
}));

vi.mock("./hooks/auto-capture.js", () => ({
  performAutoCapture: autoCapture.performAutoCapture,
}));

const { TdaiCore } = await import("./tdai-core.js");

describe("TdaiCore", () => {
  const createCore = () =>
    new TdaiCore({
      hostAdapter: {
        getLogger: () => ({
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        }),
        getRuntimeContext: () => ({ dataDir: "D:/tmp/tdai-core-test" }),
        getLLMRunnerFactory: () => ({}),
      } as never,
      config: {} as never,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    autoCapture.performAutoCapture.mockReset();
    autoCapture.performAutoCapture.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the core construction time as the cold-start capture floor", async () => {
    const constructedAt = new Date("2026-10-22T05:00:00.000Z");
    vi.setSystemTime(constructedAt);

    const core = createCore();
    vi.spyOn(core as never, "ensureSchedulerStarted").mockResolvedValue(undefined);

    vi.setSystemTime(new Date(constructedAt.getTime() + 5_000));
    await core.handleTurnCommitted({
      messages: [{ role: "user", content: "first turn" }],
      sessionKey: "session-first-turn",
    } as never);

    expect(autoCapture.performAutoCapture).toHaveBeenCalledOnce();
    expect(autoCapture.performAutoCapture.mock.calls[0][0].pluginStartTimestamp).toBe(
      constructedAt.getTime(),
    );
  });

  it("keeps an explicit turn start time as the capture floor", async () => {
    const constructedAt = new Date("2026-10-22T05:00:00.000Z");
    const turnStartedAt = constructedAt.getTime() + 2_500;
    vi.setSystemTime(constructedAt);

    const core = createCore();
    vi.spyOn(core as never, "ensureSchedulerStarted").mockResolvedValue(undefined);

    await core.handleTurnCommitted({
      messages: [{ role: "user", content: "explicit timestamp" }],
      sessionKey: "session-explicit-timestamp",
      startedAt: turnStartedAt,
    } as never);

    expect(autoCapture.performAutoCapture).toHaveBeenCalledOnce();
    expect(autoCapture.performAutoCapture.mock.calls[0][0].pluginStartTimestamp).toBe(
      turnStartedAt,
    );
  });
});
