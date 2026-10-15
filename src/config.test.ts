import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

function readManifestDefault(path: string[]): unknown {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), "openclaw.plugin.json"), "utf8"),
  ) as Record<string, unknown>;

  let current: unknown = manifest;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

describe("parseConfig", () => {
  it("keeps offload.backendTimeoutMs default aligned with the manifest schema", () => {
    const cfg = parseConfig({});
    const manifestDefault = readManifestDefault([
      "configSchema",
      "properties",
      "offload",
      "properties",
      "backendTimeoutMs",
      "default",
    ]);

    expect(manifestDefault).toBe(cfg.offload.backendTimeoutMs);
  });
});
