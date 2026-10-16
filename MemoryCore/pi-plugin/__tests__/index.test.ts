import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Pi TDAI extension", () => {
  it("registers a session-scoped skill sync command", async () => {
    vi.stubEnv("TDAI_USER_KEY", "user-key");
    vi.stubEnv("TDAI_TEAM_ID", "team-a");
    vi.stubEnv("TDAI_AGENT_ID", "agent-a");
    vi.stubEnv("TDAI_SPACE_ID", "space-a");
    const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ code: 0, data: { items: [] } })),
    );
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
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8096/skill-bridge/v3/skill/list");
    const requestInit = init as RequestInit;
    expect(requestInit.headers).toMatchObject({
      Authorization: "Bearer user-key",
      "x-tdai-service-id": "space-a",
      "x-conversation-id": "pi-session-123",
    });
    expect(JSON.parse(String(requestInit.body))).toEqual({ pagination: { limit: 50, offset: 0 } });
    expect(notify).toHaveBeenCalledWith("No mined skills are available for this TDAI agent yet.", "info");
  });

  it("reloads Pi after installing a mined skill", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "tdai-pi-command-"));
    directories.push(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("TDAI_USER_KEY", "user-key");
    vi.stubEnv("TDAI_TEAM_ID", "team-a");
    vi.stubEnv("TDAI_AGENT_ID", "agent-a");
    vi.stubEnv("TDAI_SPACE_ID", "space-a");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/list")) {
        return new Response(JSON.stringify({ code: 0, data: { items: [{ skill_id: "skl-1", name: "deploy-check", version: 1 }] } }));
      }
      return new Response(JSON.stringify({
        code: 0,
        data: {
          skill_id: "skl-1",
          name: "deploy-check",
          version: 1,
          content: "---\nname: deploy-check\ndescription: Check a deployment safely\n---\n\nRun the health check first.\n",
          manifest: [],
        },
      }));
    }));
    const pi = makePi();
    extension(pi as any);
    const command = pi.commands.find((entry) => entry.name === "tdai-memory-sync-skills");
    const reload = vi.fn(async () => undefined);

    await command!.handler("", {
      hasUI: false,
      sessionManager: { getSessionId: () => "session-123" },
      ui: { notify: vi.fn(), setStatus: vi.fn() },
      reload,
    });

    expect(reload).toHaveBeenCalledOnce();
  });
});
