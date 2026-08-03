import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitForL1Idle } from "./seed-runtime.js";

// Mock the dependencies
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockScheduler = {
  getQueueSizes: vi.fn(),
  getBufferedMessageCount: vi.fn(),
  getSessionState: vi.fn(),
  destroy: vi.fn(),
  hasSessionEnded: vi.fn(),
  setGracefulShutdown: vi.fn(),
  listSessions: vi.fn(),
  getL2Stats: vi.fn(),
  getL3Stats: vi.fn(),
  scheduleL3: vi.fn(),
  cleanupSession: vi.fn(),
};

describe("waitForL1Idle (Issue #505 fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return successfully when l1Idle is true and buffer is empty, even if conversation_count is non-zero", async () => {
    // Arrange: simulate a scenario where L1 is idle but conversation_count is stale
    mockScheduler.getQueueSizes.mockReturnValue({
      l1: 0,
      l1Pending: false,
      l1Idle: true,
      l2: 0,
      l2Pending: false,
      l2Idle: false,
      l3: 0,
      l3Pending: false,
      l3Idle: false,
    });
    mockScheduler.getBufferedMessageCount.mockReturnValue(0);
    mockScheduler.getSessionState.mockReturnValue({
      conversation_count: 1, // This is the stale value
      // ... other state properties
    });

    const sessionKeys = ["test-session"];

    // Act: call waitForL1Idle with a very short stableRounds
    const startTs = Date.now();
    await waitForL1Idle(mockScheduler as any, sessionKeys, mockLogger as any, {
      pollIntervalMs: 10,
      stableRounds: 2,
      maxWaitMs: 5000, // 5s is plenty of time
    });
    const duration = Date.now() - startTs;

    // Assert: it should return well before the maxWaitMs timeout
    expect(duration).toBeLessThan(200); // Should complete in ~20ms (2 rounds * 10ms)
    expect(mockScheduler.getQueueSizes).toHaveBeenCalled();
  });

  it("should NOT return early if l1Idle is false", async () => {
    // Arrange: L1 is still processing
    mockScheduler.getQueueSizes.mockReturnValue({
      l1: 1, // L1 has items
      l1Pending: true,
      l1Idle: false,
      l2: 0,
      l2Pending: false,
      l2Idle: false,
      l3: 0,
      l3Pending: false,
      l3Idle: false,
    });
    mockScheduler.getBufferedMessageCount.mockReturnValue(0);
    mockScheduler.getSessionState.mockReturnValue({
      conversation_count: 0,
    });

    const sessionKeys = ["test-session"];

    const startTs = Date.now();
    // We expect this to wait until maxWaitMs and then time out
    await waitForL1Idle(mockScheduler as any, sessionKeys, mockLogger as any, {
      pollIntervalMs: 10,
      stableRounds: 2,
      maxWaitMs: 100, // Short timeout for the test
    });
    const duration = Date.now() - startTs;

    // Assert: it should wait until maxWaitMs
    expect(duration).toBeGreaterThanOrEqual(90); // Allow some tolerance
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Max wait time reached")
    );
  });
});
