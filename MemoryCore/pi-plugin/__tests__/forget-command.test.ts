import { describe, expect, it, vi } from "vitest";
import { registerMemoryForgetCommand } from "../forget-command.js";
import type { ForgetCandidate, ForgetClient } from "../forget-client.js";

const candidate: ForgetCandidate = {
  key: "opaque-skill-key",
  kind: "skill",
  name: "deploy-check",
  detail: "version 3",
  preview: "Uses token [REDACTED] to check deployment health.",
  impact: "Deletes this Skill and all of its versions.",
};

function makeClient(): ForgetClient {
  return {
    preview: vi.fn(async (_keyword: string, candidateKey?: string) => candidateKey
      ? { state: "pending" as const, actionId: "action-1", candidate }
      : { state: "select" as const, candidates: [candidate] }),
    confirm: vi.fn(async () => ({
      state: "completed" as const,
      alreadyCompleted: false,
      candidate: { kind: candidate.kind, name: candidate.name },
    })),
    cancel: vi.fn(async () => ({ state: "cancelled" as const })),
  };
}

function setup(client = makeClient()) {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const pi = {
    registerCommand: vi.fn((_name: string, options: { handler: typeof handler }) => {
      handler = options.handler;
    }),
  };
  registerMemoryForgetCommand(pi as any, {
    proxyBase: "http://proxy.test",
    spaceId: "space-a",
    userKey: "user-key",
    createClient: () => client,
  });
  const ui = {
    select: vi.fn(async (_title: string, options: string[]) => options[0]),
    confirm: vi.fn(async () => true),
    notify: vi.fn(),
    setStatus: vi.fn(),
  };
  const ctx = {
    hasUI: true,
    sessionManager: { getSessionId: () => "session-1" },
    ui,
  };
  return { client, handler: handler!, ctx, ui };
}

describe("/tdai-memory-forget", () => {
  it("shows usage without contacting the server for an empty keyword", async () => {
    const { client, handler, ctx, ui } = setup();

    await handler("  ", ctx);

    expect(client.preview).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Usage: /tdai-memory-forget <keyword>", "warning");
  });

  it("fails closed in headless mode", async () => {
    const { client, handler, ctx, ui } = setup();
    ctx.hasUI = false;

    await handler("deploy", ctx);

    expect(client.preview).not.toHaveBeenCalled();
    expect(client.confirm).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(
      "Memory deletion requires Pi's interactive UI for explicit confirmation.",
      "warning",
    );
  });

  it("previews and cancels without calling delete", async () => {
    const { client, handler, ctx, ui } = setup();
    ui.confirm.mockResolvedValue(false);

    await handler("deploy", ctx);

    expect(client.preview).toHaveBeenNthCalledWith(1, "deploy");
    expect(client.preview).toHaveBeenNthCalledWith(2, "deploy", candidate.key);
    expect(ui.confirm).toHaveBeenCalledWith(
      "Delete deploy-check?",
      expect.stringContaining("[REDACTED]"),
    );
    expect(client.cancel).toHaveBeenCalledWith("action-1");
    expect(client.confirm).not.toHaveBeenCalled();
  });

  it("deletes only after explicit confirmation", async () => {
    const { client, handler, ctx, ui } = setup();

    await handler("deploy", ctx);

    expect(ui.confirm).toHaveBeenCalledOnce();
    expect(client.confirm).toHaveBeenCalledOnce();
    expect(client.confirm).toHaveBeenCalledWith("action-1");
    expect(ui.notify).toHaveBeenCalledWith(
      "Deleted Skill: deploy-check (version 3).",
      "info",
    );
    expect(ui.setStatus).toHaveBeenLastCalledWith("tdai-memory", undefined);
  });

  it("lets the user select one of multiple redacted candidates", async () => {
    const second = { ...candidate, key: "opaque-prompt-key", kind: "memory-prompt" as const, name: "agent-style" };
    const client = makeClient();
    vi.mocked(client.preview)
      .mockResolvedValueOnce({ state: "select", candidates: [candidate, second] })
      .mockResolvedValueOnce({ state: "pending", actionId: "action-2", candidate: second });
    const { handler, ctx, ui } = setup(client);
    ui.select.mockImplementation(async (_title, options) => options[1]);

    await handler("style", ctx);

    expect(ui.select).toHaveBeenCalledOnce();
    expect(client.preview).toHaveBeenNthCalledWith(2, "style", second.key);
    expect(client.confirm).toHaveBeenCalledWith("action-2");
  });
});
