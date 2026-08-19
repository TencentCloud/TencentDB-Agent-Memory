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
  it("allows an explicitly opted-in project to tune recall while retaining the global identity", async () => {
    const { agentDir, cwd } = await fixture();
    await writeFile(join(agentDir, "admin.key"), "sk-mem-test-key\n");
    await writeFile(
      join(agentDir, "tdai-memory.json"),
      JSON.stringify({
        teamId: "team-global",
        agentId: "agt-global",
        userId: "usr-global",
        userKeyFile: "./admin.key",
        allowProjectConfig: true,
      }),
    );
    await writeFile(join(cwd, ".pi", "tdai-memory.json"), JSON.stringify({ recall: { l0Limit: 2 } }));

    const result = await loadConfig({ cwd, agentDir, projectTrusted: true, env: {} });

    expect(result.ok).toBe(true);
    if (!result.ok || !result.config.enabled) return;
    expect(result.config.teamId).toBe("team-global");
    expect(result.config.agentId).toBe("agt-global");
    expect(result.config.recall.l0Limit).toBe(2);
    expect(result.config.userKey).toBe("sk-mem-test-key");
    expect(result.config.userKeySource).toBe("key file");
    expect(result.config.gatewayApiKey).toBe("sk-mem-test-key");
  });

  it("does not load a repository Memory config unless the global config explicitly allows it", async () => {
    const { agentDir, cwd } = await fixture();
    await writeFile(
      join(agentDir, "tdai-memory.json"),
      JSON.stringify({ teamId: "team-global", agentId: "agt-global", userId: "usr-global" }),
    );
    await writeFile(
      join(cwd, ".pi", "tdai-memory.json"),
      JSON.stringify({ endpoint: "https://untrusted.example", userKeyFile: "C:\\Windows\\win.ini", rejectUnauthorized: false }),
    );

    const result = await loadConfig({
      cwd,
      agentDir,
      projectTrusted: true,
      env: { TDAI_MEMORY_USER_KEY: "test-key" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !result.config.enabled) return;
    expect(result.config.endpoint).toBe("http://127.0.0.1:8420");
    expect(result.config.userKey).toBe("test-key");
    expect(result.config.sources).toEqual([join(agentDir, "tdai-memory.json")]);
  });

  it("rejects security-sensitive project fields even after the user opts in", async () => {
    const { agentDir, cwd } = await fixture();
    await writeFile(
      join(agentDir, "tdai-memory.json"),
      JSON.stringify({ teamId: "team", agentId: "agent", userId: "user", allowProjectConfig: true }),
    );
    await writeFile(
      join(cwd, ".pi", "tdai-memory.json"),
      JSON.stringify({ endpoint: "https://untrusted.example", captureTools: true, recall: { l1Limit: 2 } }),
    );

    const result = await loadConfig({ cwd, agentDir, projectTrusted: true, env: { TDAI_MEMORY_USER_KEY: "test-key" } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("project configuration may only set recall (unsupported: captureTools, endpoint)");
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

  it("defaults recall to a bounded global deadline and rejects unsafe deadline values", async () => {
    const { agentDir, cwd } = await fixture();
    const defaults = await loadConfig({
      cwd, agentDir, projectTrusted: false,
      env: { TDAI_MEMORY_TEAM_ID: "team", TDAI_MEMORY_AGENT_ID: "agent", TDAI_MEMORY_USER_ID: "user", TDAI_MEMORY_USER_KEY: "key" },
    });
    expect(defaults.ok && defaults.config.enabled && defaults.config.recall.deadlineMs).toBe(3_000);

    await writeFile(join(agentDir, "tdai-memory.json"), JSON.stringify({ recall: { deadlineMs: 99 } }));
    const invalid = await loadConfig({
      cwd, agentDir, projectTrusted: false,
      env: { TDAI_MEMORY_TEAM_ID: "team", TDAI_MEMORY_AGENT_ID: "agent", TDAI_MEMORY_USER_ID: "user", TDAI_MEMORY_USER_KEY: "key" },
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.errors).toContain("recall.deadlineMs must be an integer between 100 and 30000");
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

  it("never permits disabled TLS verification", async () => {
    const { agentDir, cwd } = await fixture();
    const result = await loadConfig({
      cwd,
      agentDir,
      projectTrusted: false,
      env: {
        TDAI_MEMORY_ENDPOINT: "https://memory.example",
        TDAI_MEMORY_TEAM_ID: "team",
        TDAI_MEMORY_AGENT_ID: "agent",
        TDAI_MEMORY_USER_ID: "user",
        TDAI_MEMORY_USER_KEY: "key",
        TDAI_MEMORY_REJECT_UNAUTHORIZED: "false",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("rejectUnauthorized=false is not supported; use a trusted TLS certificate");
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

  it("rejects unexpectedly large key files", async () => {
    const { agentDir, cwd } = await fixture();
    await writeFile(join(agentDir, "too-large.key"), "x".repeat(16 * 1024 + 1));
    await writeFile(
      join(agentDir, "tdai-memory.json"),
      JSON.stringify({ teamId: "team", agentId: "agent", userId: "user", userKeyFile: "too-large.key" }),
    );
    const result = await loadConfig({ cwd, agentDir, projectTrusted: false, env: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("user key file must not exceed 16384 bytes");
  });

  it("keeps skills disabled by default and enables them only when explicitly set", async () => {
    const { agentDir, cwd } = await fixture();
    const identity = { TDAI_MEMORY_TEAM_ID: "team", TDAI_MEMORY_AGENT_ID: "agent", TDAI_MEMORY_USER_ID: "user", TDAI_MEMORY_USER_KEY: "key" };
    const defaults = await loadConfig({ cwd, agentDir, projectTrusted: false, env: identity });
    expect(defaults.ok && defaults.config.enabled && defaults.config.skills.enabled).toBe(false);

    await writeFile(join(agentDir, "tdai-memory.json"), JSON.stringify({ skills: { enabled: true, routingMode: "hybrid", maxToolItems: 4 } }));
    const enabled = await loadConfig({ cwd, agentDir, projectTrusted: false, env: identity });
    expect(enabled.ok).toBe(true);
    if (!enabled.ok || !enabled.config.enabled) return;
    expect(enabled.config.skills.enabled).toBe(true);
    expect(enabled.config.skills.routingMode).toBe("hybrid");
    expect(enabled.config.skills.maxToolItems).toBe(4);
  });

  it("rejects invalid skills routing mode and budgets", async () => {
    const { agentDir, cwd } = await fixture();
    const identity = { TDAI_MEMORY_TEAM_ID: "team", TDAI_MEMORY_AGENT_ID: "agent", TDAI_MEMORY_USER_ID: "user", TDAI_MEMORY_USER_KEY: "key" };
    await writeFile(join(agentDir, "tdai-memory.json"), JSON.stringify({ skills: { routingMode: "bm25x" } }));
    const badMode = await loadConfig({ cwd, agentDir, projectTrusted: false, env: identity });
    expect(badMode.ok).toBe(false);
    if (!badMode.ok) expect(badMode.errors[0]).toContain("must be one of bm25, embedding, hybrid");

    await writeFile(join(agentDir, "tdai-memory.json"), JSON.stringify({ skills: { maxMessageBytes: 10 } }));
    const badBytes = await loadConfig({ cwd, agentDir, projectTrusted: false, env: identity });
    expect(badBytes.ok).toBe(false);
    if (!badBytes.ok) expect(badBytes.errors).toContain("skills.maxMessageBytes must be an integer between 1024 and 1048576");
  });

  it("rejects a repository skills override even after opting in", async () => {
    const { agentDir, cwd } = await fixture();
    await writeFile(
      join(agentDir, "tdai-memory.json"),
      JSON.stringify({ teamId: "team", agentId: "agent", userId: "user", allowProjectConfig: true }),
    );
    await writeFile(join(cwd, ".pi", "tdai-memory.json"), JSON.stringify({ skills: { enabled: true } }));

    const result = await loadConfig({ cwd, agentDir, projectTrusted: true, env: { TDAI_MEMORY_USER_KEY: "key" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("project configuration may only set recall (unsupported: skills)");
  });
});
