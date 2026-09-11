import { beforeEach, describe, expect, it, vi } from "vitest";

const { readMmd } = vi.hoisted(() => ({ readMmd: vi.fn() }));

vi.mock("./storage.js", () => ({
  listMmds: vi.fn(),
  readMmd,
}));

import { injectMmdIntoMessages, maybeUpdateMmdInMessages } from "./mmd-injector.js";

describe("injectMmdIntoMessages", () => {
  beforeEach(() => readMmd.mockReset());

  it("removes stale MMD context when injection is no longer ready", async () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "keep" }] },
      { role: "user", content: [{ type: "text", text: "stale" }], _mmdContextMessage: "active" },
    ];
    const stateManager = {
      l15Settled: true,
      lastMmdInjectedTokens: 42,
      isMmdInjectionReady: () => false,
      getActiveMmdFile: () => null,
    } as any;
    const logger = { debug: () => {} } as any;

    const result = await injectMmdIntoMessages(messages, stateManager, logger, () => 1_000, {});

    expect(result.mmdTokens).toBe(0);
    expect(stateManager.lastMmdInjectedTokens).toBe(0);
    expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: "keep" }] }]);
  });

  it("removes stale MMD context when the active MMD cannot be read", async () => {
    readMmd.mockResolvedValue(null);
    const messages = [
      { role: "user", content: [{ type: "text", text: "keep" }] },
      { role: "user", content: [{ type: "text", text: "stale" }], _mmdContextMessage: "active" },
    ];
    const stateManager = {
      l15Settled: true,
      lastMmdInjectedTokens: 42,
      ctx: {},
      isMmdInjectionReady: () => true,
      getActiveMmdFile: () => "active.mmd",
      getLastSessionKey: () => "session-1",
    } as any;
    const logger = { debug: () => {}, error: () => {} } as any;

    const result = await injectMmdIntoMessages(messages, stateManager, logger, () => 1_000, {});

    expect(result.mmdTokens).toBe(0);
    expect(stateManager.lastMmdInjectedTokens).toBe(0);
    expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: "keep" }] }]);
  });

  it("replaces the active MMD after an update instead of accumulating prompt context", async () => {
    const firstMmd = "flowchart TD\nN1[doing]";
    const secondMmd = "flowchart TD\nN1[done] --> N2[doing]";
    readMmd
      .mockResolvedValueOnce(firstMmd)
      .mockResolvedValueOnce(secondMmd)
      .mockResolvedValueOnce(secondMmd);
    let injectedVersion: string | undefined;
    const stateManager = {
      l15Settled: true,
      lastMmdInjectedTokens: 0,
      ctx: {},
      isMmdInjectionReady: () => true,
      getActiveMmdFile: () => "active.mmd",
      getInjectedMmdVersion: () => injectedVersion,
      setInjectedMmdVersion: (_file: string, version: string) => { injectedVersion = version; },
      getLastSessionKey: () => "session-1",
    } as any;
    const logger = { debug: () => {}, error: () => {} } as any;
    const messages = [{ role: "user", content: [{ type: "text", text: "keep" }] }];

    await injectMmdIntoMessages(messages, stateManager, logger, () => 1_000, {});
    await maybeUpdateMmdInMessages(messages, stateManager, logger, () => 1_000, {});

    expect(messages.filter((message: any) => message._mmdContextMessage === "active")).toHaveLength(1);
    expect(messages.find((message: any) => message._mmdContextMessage === "active")?.content?.[0]?.text).toContain("N2[doing]");
    expect(stateManager.lastMmdInjectedTokens).toBeGreaterThan(0);
  });
});
