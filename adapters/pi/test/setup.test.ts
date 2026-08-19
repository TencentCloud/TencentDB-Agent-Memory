import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSetup, type SetupMemoryClient, type SetupMetadataClient } from "../src/setup.js";

const roots: string[] = [];

async function fixture(): Promise<{ root: string; agentDir: string; cwd: string; keyPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "tdai-pi-setup-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const keyPath = join(root, "admin.key");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(keyPath, "sk-mem-real-secret\n", { mode: 0o600 });
  return { root, agentDir, cwd, keyPath };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function clients(): { metadata: SetupMetadataClient; memory: SetupMemoryClient } {
  const metadata: SetupMetadataClient = {
    verifyAuth: vi.fn().mockResolvedValue({ valid: true, user: { user_id: "usr-1", username: "alice" } }),
    listTeams: vi.fn().mockResolvedValue({
      total: 1,
      items: [{ team_id: "team-1", name: "Personal", status: "active" }],
    }),
    listAgents: vi.fn().mockResolvedValue({
      total: 1,
      items: [{ agent_id: "agt-1", team_id: "team-1", name: "Existing Pi", status: "active" }],
    }),
    createAgent: vi.fn(),
    archiveAgent: vi.fn().mockResolvedValue({}),
  };
  const memory: SetupMemoryClient = {
    queryConversation: vi.fn().mockResolvedValue({ items: [] }),
    searchAtomic: vi.fn().mockResolvedValue({ items: [] }),
    listScenarios: vi.fn().mockResolvedValue({ items: [] }),
    readCore: vi.fn().mockResolvedValue({ content: "" }),
  };
  return { metadata, memory };
}

function interactiveContext(cwd: string, inputs: string[], selectChoice?: (title: string, options: string[]) => string | undefined) {
  return {
    cwd,
    hasUI: true,
    ui: {
      input: vi.fn(async () => inputs.shift()),
      select: vi.fn(async (title: string, options: string[]) => selectChoice?.(title, options) ?? options[0]),
      confirm: vi.fn(async () => true),
      setStatus: vi.fn(),
    },
  };
}

describe("Pi memory setup", () => {
  it("verifies identity and all four memory layers, then saves only a key-file reference", async () => {
    const { agentDir, cwd, keyPath } = await fixture();
    await writeFile(join(agentDir, "tdai-memory.json"), JSON.stringify({ recall: { l0Limit: 2 }, captureTools: true, gatewayApiKeyFile: "old.key" }));
    const { metadata, memory } = clients();
    const ctx = interactiveContext(cwd, ["", "", keyPath, ""], (title, options) => {
      return title === "Select Memory Agent" ? options[1] : options[0];
    });

    const result = await runSetup(ctx as never, {
      agentDir,
      createMetadataClient: () => metadata,
      createMemoryClient: () => memory,
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, createdAgent: false }));
    expect(metadata.verifyAuth).toHaveBeenCalledWith("sk-mem-real-secret");
    expect(metadata.listTeams).toHaveBeenCalledWith({ user_id: "usr-1", limit: 100, offset: 0 });
    expect(metadata.listAgents).toHaveBeenCalledWith({ team_id: "team-1", status: "active", limit: 100, offset: 0 });
    expect(memory.queryConversation).toHaveBeenCalledWith({ limit: 1, offset: 0 });
    expect(memory.searchAtomic).toHaveBeenCalledWith({ query: "setup capability check", limit: 1 });
    expect(memory.listScenarios).toHaveBeenCalledOnce();
    expect(memory.readCore).toHaveBeenCalledOnce();

    const saved = await readFile(join(agentDir, "tdai-memory.json"), "utf8");
    expect(saved).not.toContain("sk-mem-real-secret");
    expect(JSON.parse(saved)).toMatchObject({
      schemaVersion: 1,
      endpoint: "http://127.0.0.1:8420",
      serviceId: "default",
      teamId: "team-1",
      agentId: "agt-1",
      userId: "usr-1",
      userKeyFile: keyPath,
      recall: { l0Limit: 2 },
      captureTools: true,
    });
    expect(JSON.parse(saved)).not.toHaveProperty("gatewayApiKeyFile");
  });

  it("warns before reusing a non-private (team-visible) agent and re-prompts when declined", async () => {
    const { agentDir, cwd, keyPath } = await fixture();
    const { metadata, memory } = clients();
    // Cold start: the server auto-created a team-visible default-agent.
    vi.mocked(metadata.listAgents).mockResolvedValue({
      total: 1,
      items: [{ agent_id: "agt-1", team_id: "team-1", name: "Existing Pi", status: "active", visibility: "team" }],
    });
    vi.mocked(metadata.createAgent).mockResolvedValue({ agent_id: "agt-new", team_id: "team-1", name: "Pi", status: "active" });

    let selects = 0;
    const inputs = ["", "", keyPath, "", ""];
    const ctx = {
      cwd,
      hasUI: true,
      ui: {
        input: vi.fn(async () => inputs.shift()),
        select: vi.fn(async () => {
          // select calls: 1) team, 2) agent -> team-visible, 3) agent re-prompt
          // after declining the warning -> create a private Pi agent.
          const step = selects++;
          if (step === 0) return "Personal (team-1)";
          if (step === 1) return "Existing Pi (agt-1)";
          return "+ Create a private Pi agent";
        }),
        confirm: vi.fn(async () => false),
        setStatus: vi.fn(),
      },
    };

    const result = await runSetup(ctx as never, {
      agentDir,
      createMetadataClient: () => metadata,
      createMemoryClient: () => memory,
    });

    if (!result.ok) throw new Error("setup should have succeeded");
    expect(result.createdAgent).toBe(true);
    // Declined once, then created a private agent — never reused the team-visible one.
    expect(vi.mocked(metadata.createAgent)).toHaveBeenCalledWith(expect.objectContaining({ visibility: "private" }));
    expect(JSON.parse(await readFile(join(agentDir, "tdai-memory.json"), "utf8"))).toMatchObject({ agentId: "agt-new" });
    void keyPath;
  });

  it("can create a private Pi agent when the user selects that option", async () => {
    const { agentDir, cwd, keyPath } = await fixture();
    const { metadata, memory } = clients();
    vi.mocked(metadata.createAgent).mockResolvedValue({ agent_id: "agt-new", team_id: "team-1", name: "Pi", status: "active" });
    const ctx = interactiveContext(cwd, ["", "", keyPath, "", ""], (_title, options) => {
      return options[0];
    });

    const result = await runSetup(ctx as never, {
      agentDir,
      createMetadataClient: () => metadata,
      createMemoryClient: () => memory,
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, createdAgent: true }));
    expect(metadata.createAgent).toHaveBeenCalledWith({
      team_id: "team-1",
      owner_user_id: "usr-1",
      name: "Pi",
      description: "Private long-term memory space for Pi.",
      visibility: "private",
      status: "active",
    });
  });

  it("archives an Agent it just created if the read-only capability check fails", async () => {
    const { agentDir, cwd, keyPath } = await fixture();
    const { metadata, memory } = clients();
    vi.mocked(metadata.createAgent).mockResolvedValue({ agent_id: "agt-new", team_id: "team-1", name: "Pi", status: "active" });
    vi.mocked(memory.readCore).mockRejectedValue(new Error("Bearer sk-mem-very-secret was rejected"));
    const ctx = interactiveContext(cwd, ["", "", keyPath, "", ""], (_title, options) => options[0]);

    const result = await runSetup(ctx as never, {
      agentDir,
      createMetadataClient: () => metadata,
      createMemoryClient: () => memory,
    });

    expect(result).toEqual({ ok: false, cancelled: false, message: "Memory setup failed: Bearer [REDACTED] was rejected" });
    expect(metadata.archiveAgent).toHaveBeenCalledWith("agt-new");
  });

  it("does not try to collect credentials when Pi has no interactive UI", async () => {
    const result = await runSetup({ cwd: "C:\\workspace", hasUI: false, ui: {} } as never);
    expect(result).toEqual({ ok: false, cancelled: false, message: "Memory setup requires an interactive Pi UI." });
  });
});
