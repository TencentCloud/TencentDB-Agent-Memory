import { describe, expect, it, vi } from "vitest";
import { registerMemoryForgetCommand } from "../forget-command.js";
import type { ForgetCandidate, ForgetClient } from "../forget-client.js";

const candidate: ForgetCandidate = {
  actionId: "action-1",
  kind: "skill",
  name: "deploy-check",
  detail: "version 3",
  preview: "Uses token [REDACTED] to check deployment health.",
  impact: "Deletes this Skill and all of its versions.",
};

function makeClient(): ForgetClient {
  return {
    preview: vi.fn(async () => ({ state: "select" as const, candidates: [candidate] })),
    confirm: vi.fn(async () => undefined),
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
    confirm: vi.fn(async (_title: string, _message: string) => true),
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

    expect(client.preview).toHaveBeenCalledOnce();
    expect(client.preview).toHaveBeenCalledWith("deploy");
    expect(ui.confirm).toHaveBeenCalledWith(
      "Delete deploy-check?",
      expect.stringContaining("[REDACTED]"),
    );
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
    const second = { ...candidate, actionId: "action-2", kind: "memory-prompt" as const, name: "agent-style" };
    const client = makeClient();
    vi.mocked(client.preview)
      .mockResolvedValueOnce({ state: "select", candidates: [candidate, second] });
    const { handler, ctx, ui } = setup(client);
    ui.select.mockImplementation(async (_title, options) => options[1]);

    await handler("style", ctx);

    expect(ui.select).toHaveBeenCalledOnce();
    expect(client.preview).toHaveBeenCalledOnce();
    expect(client.confirm).toHaveBeenCalledWith("action-2");
  });
});
