import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const roots: string[] = [];

async function fixture(): Promise<{ root: string; agentDir: string; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), "tdai-pi-config-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  return { root, agentDir, cwd };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("loadConfig", () => {
  it("merges trusted project config while resolving a global key file against its declaring file", async () => {
    const { agentDir, cwd } = await fixture();
    await writeFile(join(agentDir, "admin.key"), "sk-mem-test-key\n");
    await writeFile(
      join(agentDir, "tdai-memory.json"),
      JSON.stringify({
        teamId: "team-global",
        agentId: "agt-global",
        userId: "usr-global",
        userKeyFile: "./admin.key",
      }),
    );
    await writeFile(join(cwd, ".pi", "tdai-memory.json"), JSON.stringify({ teamId: "team-project" }));

    const result = await loadConfig({ cwd, agentDir, projectTrusted: true, env: {} });

    expect(result.ok).toBe(true);
    if (!result.ok || !result.config.enabled) return;
    expect(result.config.teamId).toBe("team-project");
    expect(result.config.agentId).toBe("agt-global");
    expect(result.config.userKey).toBe("sk-mem-test-key");
    expect(result.config.userKeySource).toBe("key file");
    expect(result.config.gatewayApiKey).toBe("sk-mem-test-key");
  });

  it("ignores project configuration before project trust is granted", async () => {
    const { agentDir, cwd } = await fixture();
    await writeFile(
      join(agentDir, "tdai-memory.json"),
      JSON.stringify({ teamId: "team-global", agentId: "agt", userId: "usr" }),
    );
    await writeFile(join(cwd, ".pi", "tdai-memory.json"), JSON.stringify({ teamId: "team-untrusted" }));

    const result = await loadConfig({
      cwd,
      agentDir,
      projectTrusted: false,
      env: { TDAI_MEMORY_USER_KEY: "sk-mem-test" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !result.config.enabled) return;
    expect(result.config.teamId).toBe("team-global");
    expect(result.config.sources).toEqual([join(agentDir, "tdai-memory.json")]);
  });

  it("applies environment variables last and resolves environment key files from cwd", async () => {
    const { agentDir, cwd } = await fixture();
    await writeFile(join(cwd, "env.key"), "env-secret\n");

    const result = await loadConfig({
      cwd,
      agentDir,
      projectTrusted: false,
      env: {
        TDAI_MEMORY_TEAM_ID: "team-env",
        TDAI_MEMORY_AGENT_ID: "agt-env",
        TDAI_MEMORY_USER_ID: "usr-env",
        TDAI_MEMORY_USER_KEY_FILE: "env.key",
        TDAI_MEMORY_TIMEOUT_MS: "1250",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !result.config.enabled) return;
    expect(result.config.teamId).toBe("team-env");
    expect(result.config.userKey).toBe("env-secret");
    expect(result.config.timeoutMs).toBe(1250);
  });

  it("allows disabled configuration without credentials or isolation ids", async () => {
    const { agentDir, cwd } = await fixture();
    await writeFile(join(agentDir, "tdai-memory.json"), JSON.stringify({ enabled: false }));

    const result = await loadConfig({ cwd, agentDir, projectTrusted: false, env: {} });

    expect(result).toEqual({
      ok: true,
      config: { enabled: false, sources: [join(agentDir, "tdai-memory.json")] },
    });
  });

  it("keeps tool capture opt-in and disabled by default", async () => {
    const { agentDir, cwd } = await fixture();
    const defaults = await loadConfig({
      cwd, agentDir, projectTrusted: false,
      env: { TDAI_MEMORY_TEAM_ID: "team", TDAI_MEMORY_AGENT_ID: "agent", TDAI_MEMORY_USER_ID: "user", TDAI_MEMORY_USER_KEY: "key" },
    });
    expect(defaults.ok && defaults.config.enabled && defaults.config.captureTools).toBe(false);
    await writeFile(join(agentDir, "tdai-memory.json"), JSON.stringify({ captureTools: true }));
    const enabled = await loadConfig({
      cwd, agentDir, projectTrusted: false,
      env: { TDAI_MEMORY_TEAM_ID: "team", TDAI_MEMORY_AGENT_ID: "agent", TDAI_MEMORY_USER_ID: "user", TDAI_MEMORY_USER_KEY: "key" },
    });
    expect(enabled.ok && enabled.config.enabled && enabled.config.captureTools).toBe(true);
  });

  it.each([
    ["http://example.com:8420", "remote endpoints must use HTTPS"],
    ["https://user:password@example.com", "endpoint must not contain username or password"],
  ])("rejects unsafe endpoint %s", async (endpoint, expected) => {
    const { agentDir, cwd } = await fixture();
    const result = await loadConfig({
      cwd,
      agentDir,
      projectTrusted: false,
      env: {
        TDAI_MEMORY_ENDPOINT: endpoint,
        TDAI_MEMORY_TEAM_ID: "team",
        TDAI_MEMORY_AGENT_ID: "agent",
        TDAI_MEMORY_USER_ID: "user",
        TDAI_MEMORY_USER_KEY: "key",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain(expected);
  });

  it("rejects invalid environment booleans and pipe-delimited isolation ids", async () => {
    const { agentDir, cwd } = await fixture();
    const result = await loadConfig({
      cwd,
      agentDir,
      projectTrusted: false,
      env: {
        TDAI_MEMORY_TEAM_ID: "team|bad",
        TDAI_MEMORY_AGENT_ID: "agent",
        TDAI_MEMORY_USER_ID: "user",
        TDAI_MEMORY_USER_KEY: "key",
        TDAI_MEMORY_REJECT_UNAUTHORIZED: "sometimes",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("teamId must not contain |");
    expect(result.errors).toContain("TDAI_MEMORY_REJECT_UNAUTHORIZED must be true or false");
  });

  it("rejects a symbolic-link key file when the platform permits creating it", async () => {
    const { root, agentDir, cwd } = await fixture();
    const realKey = join(root, "real.key");
    const linkedKey = join(agentDir, "linked.key");
    await writeFile(realKey, "secret");
    try {
      await symlink(realKey, linkedKey, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") return;
      throw error;
    }
    await writeFile(
      join(agentDir, "tdai-memory.json"),
      JSON.stringify({ teamId: "team", agentId: "agent", userId: "user", userKeyFile: "linked.key" }),
    );

    const result = await loadConfig({ cwd, agentDir, projectTrusted: false, env: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("user key file must be a regular file, not a directory or symbolic link");
  });
});
