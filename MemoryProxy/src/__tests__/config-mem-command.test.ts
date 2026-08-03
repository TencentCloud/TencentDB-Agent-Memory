import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConfig } from "../config.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("memCommand config", () => {
  it("loads the optional YAML section and filters invalid commands", () => {
    tempDir = mkdtempSync(join(tmpdir(), "proxy-config-"));
    const configPath = join(tempDir, "config.yaml");
    writeFileSync(
      configPath,
      [
        "memCommand:",
        "  enabled: true",
        "  allowedCommands:",
        "    - sync",
        "    - 42",
        "    - help",
        "",
      ].join("\n"),
    );

    const config = buildConfig({ configFile: configPath });

    expect(config.memCommand).toEqual({
      enabled: true,
      allowedCommands: ["sync", "help"],
    });
  });
});
