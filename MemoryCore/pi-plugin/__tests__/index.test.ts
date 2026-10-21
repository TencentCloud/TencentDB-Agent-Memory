import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerPiMemory from "../index.js";
import { BRANCH_ENTRY_TYPE, BRANCH_HEADER } from "../branch-identity.js";

type Handler = (event: any, ctx: any) => unknown;

function createHarness(initialEntries: unknown[] = []) {
  const entries = [...initialEntries];
  const handlers = new Map<string, Handler>();
  const appendEntry = vi.fn((customType: string, data: unknown) => {
    entries.push({ type: "custom", customType, data });
  });
  const pi = {
    registerProvider: vi.fn(),
    on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    appendEntry,
  };
  registerPiMemory(pi as never);

  const ctx = {
    model: { provider: "tdai" },
    sessionManager: {
      getSessionId: () => "session-123",
      getBranch: () => entries,
    },
  };

  return { appendEntry, entries, handlers, ctx };
}

describe("Pi branch marker wiring", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TDAI_USER_KEY = "usr_test.secret";
    process.env.TDAI_TEAM_ID = "team-test";
    process.env.TDAI_AGENT_ID = "agent-test";
    delete process.env.TDAI_BRANCH_ISOLATION;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("keeps the legacy conversation id when an existing session has no marker", () => {
    const { handlers, ctx } = createHarness();
    handlers.get("session_start")?.({}, ctx);

    const event = { headers: {} as Record<string, string> };
    handlers.get("before_provider_headers")?.(event, ctx);

    expect(event.headers["x-conversation-id"]).toBe("pi-session-123");
    expect(event.headers[BRANCH_HEADER]).toBeUndefined();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("creates a marker for an unmarked /tree branch and forwards it", () => {
    const { appendEntry, handlers, ctx } = createHarness();
    handlers.get("session_tree")?.({}, ctx);

    expect(appendEntry).toHaveBeenCalledWith(
      BRANCH_ENTRY_TYPE,
      expect.objectContaining({ branchId: expect.stringMatching(/^branch-/) }),
    );

    const event = { headers: {} as Record<string, string> };
    handlers.get("before_provider_headers")?.(event, ctx);
    expect(event.headers["x-conversation-id"]).toBe("pi-session-123");
    expect(event.headers[BRANCH_HEADER]).toMatch(/^branch-/);
  });

  it("restores the persisted marker when returning to a branch", () => {
    const { appendEntry, handlers, ctx } = createHarness([
      {
        type: "custom",
        customType: BRANCH_ENTRY_TYPE,
        data: { branchId: "branch-returned" },
      },
    ]);
    handlers.get("session_tree")?.({}, ctx);

    const event = { headers: {} as Record<string, string> };
    handlers.get("before_provider_headers")?.(event, ctx);
    expect(event.headers[BRANCH_HEADER]).toBe("branch-returned");
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("supports opting out without changing the legacy request", () => {
    process.env.TDAI_BRANCH_ISOLATION = "0";
    const { appendEntry, handlers, ctx } = createHarness();
    handlers.get("session_tree")?.({}, ctx);

    const event = { headers: {} as Record<string, string> };
    handlers.get("before_provider_headers")?.(event, ctx);
    expect(event.headers).toEqual({ "x-conversation-id": "pi-session-123" });
    expect(appendEntry).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });
});
