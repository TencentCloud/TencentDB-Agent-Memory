import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const environmentKeys = [
  "TDAI_MEMORY_ENDPOINT",
  "TDAI_MEMORY_API_KEY",
  "TDAI_MEMORY_SERVICE_ID",
  "TDAI_MEMORY_TEAM_ID",
  "TDAI_MEMORY_AGENT_ID",
  "TDAI_MEMORY_USER_ID",
  "TDAI_MEMORY_TASK_ID",
  "TDAI_PI_TIMEOUT_MS",
  "TDAI_PI_RECALL_LIMIT",
  "TDAI_PI_SCENARIO_LIMIT",
  "TDAI_PI_MAX_CONTEXT_CHARS",
  "TDAI_PI_MAX_CAPTURE_CHARS",
  "TDAI_PI_INCLUDE_CORE",
  "TDAI_PI_INCLUDE_SCENARIOS",
  "TDAI_PI_ALLOW_INSECURE_HTTP",
];

describe("Pi package", () => {
  it("declares a standalone extension and peer-only Pi runtime dependencies", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
      pi?: { extensions?: string[] };
      peerDependencies?: Record<string, string>;
    };
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.pi?.extensions).toEqual(["./src/index.ts"]);
    expect(manifest.peerDependencies).toMatchObject({
      "@earendil-works/pi-coding-agent": "*",
      typebox: "*",
    });
  });

  it("keeps required setup keys in both language guides", async () => {
    const [english, chinese] = await Promise.all([
      readFile(new URL("../README.md", import.meta.url), "utf8"),
      readFile(new URL("../README_CN.md", import.meta.url), "utf8"),
    ]);
    for (const key of environmentKeys) {
      expect(english, "English guide missing " + key).toContain(key);
      expect(chinese, "Chinese guide missing " + key).toContain(key);
    }
    expect(english).toContain("/tdai-memory-status");
    expect(chinese).toContain("/tdai-memory-status");
  });
});
