import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../");
const startProxy = readFileSync(
  resolve(repoRoot, "deploy/global-images/start-proxy.sh"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("official proxy deployment config", () => {
  it("generates the knowledge config required by KnowledgeToolsInjector", () => {
    expect(startProxy).toContain([
      "knowledge:",
      "  enabled: true",
      '  endpoint: "http://memory-core:8420"',
      '  serviceToken: "${MEMORY_CORE_GATEWAY_API_KEY}"',
      "  serviceId: default",
    ].join("\n"));
  });
});
