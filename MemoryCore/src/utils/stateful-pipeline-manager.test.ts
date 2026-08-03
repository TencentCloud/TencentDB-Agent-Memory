import { afterEach, describe, expect, it, vi } from "vitest";
import type { IStateBackend } from "../core/state/types.js";
import {
  StatefulPipelineManager,
  type PipelineConfig,
} from "./stateful-pipeline-manager.js";

const config: PipelineConfig = {
  everyNConversations: 5,
  enableWarmup: false,
  l1: {
    idleTimeoutSeconds: 60,
  },
  l2: {
    delayAfterL1Seconds: 90,
    minIntervalSeconds: 900,
    maxIntervalSeconds: 3_600,
    sessionActiveWindowHours: 24,
  },
};

function createManager() {
  const setTimer = vi.fn().mockResolvedValue(undefined);
  const backend = { setTimer } as unknown as IStateBackend;
  return {
    manager: new StatefulPipelineManager(config, backend, "default"),
    setTimer,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StatefulPipelineManager.armL2MaxInterval", () => {
  it("preserves team and agent scope in the periodic L2 timer member", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { manager, setTimer } = createManager();

    await manager.armL2MaxInterval(
      "session one",
      "instance-1",
      "team:a",
      "agent/b",
    );

    expect(setTimer).toHaveBeenCalledWith(
      "instance-1",
      "scope:team:team%3Aa|agent:agent%2Fb|session:session%20one:L2_schedule",
      3_601_000,
    );
  });

  it("keeps the legacy timer member when tenant scope is unavailable", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    const { manager, setTimer } = createManager();

    await manager.armL2MaxInterval("session-legacy", "instance-2");

    expect(setTimer).toHaveBeenCalledWith(
      "instance-2",
      "session-legacy:L2_schedule",
      3_602_000,
    );
  });
});
