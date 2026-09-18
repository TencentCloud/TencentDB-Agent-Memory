import { afterEach, describe, expect, it, vi } from "vitest";
import extension from "../index.js";

type RegisteredCommand = {
  name: string;
  handler: (args: string, ctx: any) => Promise<void>;
};

function makePi() {
  const commands: RegisteredCommand[] = [];
  return {
    commands,
    registerProvider: vi.fn(),
    registerCommand: vi.fn((name: string, options: Omit<RegisteredCommand, "name">) => {
      commands.push({ name, ...options });
    }),
    on: vi.fn(),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Pi TDAI extension", () => {
  it("registers a session-scoped skill sync command", async () => {
    vi.stubEnv("TDAI_USER_KEY", "user-key");
    vi.stubEnv("TDAI_TEAM_ID", "team-a");
    vi.stubEnv("TDAI_AGENT_ID", "agent-a");
    vi.stubEnv("TDAI_SPACE_ID", "space-a");
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { items: [] } })));
    vi.stubGlobal("fetch", fetcher);
    const pi = makePi();

    extension(pi as any);

    const command = pi.commands.find((entry) => entry.name === "tdai-memory-sync-skills");
    expect(command).toBeDefined();
    const notify = vi.fn();
    await command!.handler("", {
      hasUI: false,
      sessionManager: { getSessionId: () => "session-123" },
      ui: { notify, setStatus: vi.fn() },
    });

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8096/skill-bridge/v3/skill/list");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer user-key",
      "x-tdai-service-id": "space-a",
      "x-conversation-id": "pi-session-123",
    });
    expect(init.body).toBe("{}");
    expect(notify).toHaveBeenCalledWith("No mined skills are available for this TDAI agent yet.", "info");
  });
});
