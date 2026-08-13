import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, publicConfig } from "../src/config.js";

const clean = { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "tdai-opencode-clean-")) };
const base = {
  ...clean,
  TDAI_MEMORY_API_KEY: "secret-key",
  TDAI_MEMORY_SERVICE_ID: "space",
  TDAI_MEMORY_TEAM_ID: "team",
  TDAI_MEMORY_AGENT_ID: "opencode",
  TDAI_MEMORY_USER_ID: "user",
};

describe("configuration", () => {
  it("uses secure local defaults", () => {
    const result = loadConfig(clean);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.endpoint).toBe("http://127.0.0.1:8420");
    expect(result.value.agentId).toBe("opencode");
    expect(result.value.apiKey).toBe("local");
    expect(result.value.maxMessageChars).toBe(8_192);
    expect(result.value.skillEnabled).toBe(false);
    expect(result.value.stateDir).toContain("tencentdb-agent-memory");
  });

  it("requires an explicit opt-in for Skill and enforces the Gateway message limit", () => {
    const enabled = loadConfig({ ...clean, TDAI_OPENCODE_SKILL_ENABLED: "true" });
    expect(enabled.ok && enabled.value.skillEnabled).toBe(true);

    const oversized = loadConfig({ ...clean, TDAI_OPENCODE_MAX_MESSAGE_CHARS: "8193" });
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.errors[0]).toContain("between 500 and 8192");
  });

  it("rejects remote plaintext and embedded credentials", () => {
    expect(loadConfig({ ...base, TDAI_MEMORY_ENDPOINT: "http://remote.example/v3" }).ok).toBe(false);
    expect(loadConfig({ ...base, TDAI_MEMORY_ENDPOINT: "https://u:p@remote.example" }).ok).toBe(false);
    expect(loadConfig({ ...base, TDAI_MEMORY_ENDPOINT: "https://remote.example?token=nope" }).ok).toBe(false);
  });

  it("requires explicit isolation and credentials for a remote Gateway", () => {
    const result = loadConfig({ ...clean, TDAI_MEMORY_ENDPOINT: "https://memory.example" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("Remote Gateway requires explicit apiKey");
    expect(result.errors).toContain("Remote Gateway requires explicit userId");
  });

  it("rejects IDs that would corrupt Skill queue isolation", () => {
    const result = loadConfig({ ...base, TDAI_MEMORY_TEAM_ID: "bad|team" });
    expect(result.ok).toBe(false);
  });

  it("enforces the Skill Gateway task ID limit before capture", () => {
    const result = loadConfig({ ...base, TDAI_MEMORY_TASK_ID: "x".repeat(129) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("TDAI_MEMORY_TASK_ID must be at most 128 characters");
  });

  it("never exposes the API key", () => {
    const result = loadConfig(base);
    if (!result.ok) throw new Error("config failed");
    expect(JSON.stringify(publicConfig(result.value))).not.toContain("secret-key");
    expect(JSON.stringify(publicConfig(result.value))).not.toContain(result.value.stateDir);
  });

  it("loads a private config file and lets environment variables override it", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tdai-opencode-config-")), "memory.json");
    writeFileSync(path, JSON.stringify({ endpoint: "http://127.0.0.1:18420", recallLimit: 7, apiKey: "file-secret" }));
    const result = loadConfig({ TDAI_OPENCODE_CONFIG_FILE: path, TDAI_OPENCODE_RECALL_LIMIT: "9" });
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.value.endpoint).toBe("http://127.0.0.1:18420");
    expect(result.value.recallLimit).toBe(9);
    expect(result.value.apiKey).toBe("file-secret");
  });

  it("fails closed for malformed or misspelled config file fields", () => {
    const directory = mkdtempSync(join(tmpdir(), "tdai-opencode-config-"));
    const malformed = join(directory, "malformed.json");
    const typo = join(directory, "typo.json");
    writeFileSync(malformed, "{");
    writeFileSync(typo, JSON.stringify({ endpont: "http://127.0.0.1:8420" }));
    expect(loadConfig({ TDAI_OPENCODE_CONFIG_FILE: malformed }).ok).toBe(false);
    expect(loadConfig({ TDAI_OPENCODE_CONFIG_FILE: typo }).ok).toBe(false);
    expect(loadConfig({ TDAI_OPENCODE_CONFIG_FILE: join(directory, "missing.json") }).ok).toBe(false);
  });

  it("rejects misspelled booleans instead of silently disabling capture", () => {
    const result = loadConfig({ ...clean, TDAI_OPENCODE_CAPTURE_ENABLED: "treu" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain(
      "TDAI_OPENCODE_CAPTURE_ENABLED must be a boolean (true/false, yes/no, on/off, or 1/0)",
    );
  });
});
