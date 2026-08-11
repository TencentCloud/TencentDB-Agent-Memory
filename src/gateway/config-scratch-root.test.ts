/**
 * The scratch root is resolved ONCE, in the config (tz-02 критерий 2) — the
 * spawn side and the cleanup sweep both read `data.scratchRoot`, so what this
 * function returns is what the two of them agree on.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadGatewayConfig } from "./config.js";

let dir: string;
const saved = {
  cfg: process.env.TDAI_GATEWAY_CONFIG,
  data: process.env.TDAI_DATA_DIR,
  scratch: process.env.TDAI_SCRATCH_ROOT,
};

function writeConfig(body: string[]): void {
  const p = path.join(dir, "tdai-gateway.yaml");
  fs.writeFileSync(p, body.join("\n"), "utf-8");
  process.env.TDAI_GATEWAY_CONFIG = p;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-cfg-"));
  delete process.env.TDAI_DATA_DIR;
  delete process.env.TDAI_SCRATCH_ROOT;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ["TDAI_GATEWAY_CONFIG", saved.cfg],
    ["TDAI_DATA_DIR", saved.data],
    ["TDAI_SCRATCH_ROOT", saved.scratch],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("data.scratchRoot", () => {
  it("defaults to a sibling of baseDir, outside the memory tree", () => {
    writeConfig(["data:", `  baseDir: ${path.join(dir, "memory", "tdai")}`]);
    const cfg = loadGatewayConfig();
    expect(cfg.data.scratchRoot).toBe(
      path.join(dir, "memory", "tdai-memory-keeper"),
    );
    // Outside, not under: a child cwd'd there cannot reach memory files by
    // walking up one level.
    // Prefix-as-string is not the question ("tdai-memory-keeper" starts with
    // "tdai"); path containment is.
    expect(cfg.data.scratchRoot.startsWith(cfg.data.baseDir + path.sep)).toBe(
      false,
    );
  });

  it("takes the yaml value, and the env wins over it", () => {
    writeConfig([
      "data:",
      `  baseDir: ${path.join(dir, "memory", "tdai")}`,
      `  scratchRoot: ${path.join(dir, "from-yaml")}`,
    ]);
    expect(loadGatewayConfig().data.scratchRoot).toBe(
      path.join(dir, "from-yaml"),
    );

    process.env.TDAI_SCRATCH_ROOT = path.join(dir, "from-env");
    expect(loadGatewayConfig().data.scratchRoot).toBe(
      path.join(dir, "from-env"),
    );
  });

  it("moves the derived default WITH an overridden baseDir", () => {
    // e2e overrides patch data.baseDir and say nothing about the scratch root.
    // Keeping the sibling of the ORIGINAL baseDir would send a test run's
    // scratch into the operator's real home tree.
    writeConfig(["data:", `  baseDir: ${path.join(dir, "memory", "tdai")}`]);
    const cfg = loadGatewayConfig({
      data: { baseDir: path.join(dir, "elsewhere", "tdai") } as never,
    });
    expect(cfg.data.scratchRoot).toBe(
      path.join(dir, "elsewhere", "tdai-memory-keeper"),
    );
  });

  it("keeps an explicitly configured root when baseDir is overridden", () => {
    writeConfig([
      "data:",
      `  baseDir: ${path.join(dir, "memory", "tdai")}`,
      `  scratchRoot: ${path.join(dir, "from-yaml")}`,
    ]);
    const cfg = loadGatewayConfig({
      data: { baseDir: path.join(dir, "elsewhere", "tdai") } as never,
    });
    expect(cfg.data.scratchRoot).toBe(path.join(dir, "from-yaml"));
  });
});
