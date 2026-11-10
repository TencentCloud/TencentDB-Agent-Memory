import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

describe("Panel deployment runtime wiring", () => {
  it("forwards the analytics entry gate to the combined container", () => {
    expect(read("deploy/global-images/start-memory-hub.sh")).toContain(
      'PANEL_FEATURE_ANALYTICS_ENABLED="${PANEL_FEATURE_ANALYTICS_ENABLED:-false}"',
    );
  });

  it("authenticates the documented Knowledge analytics probe", () => {
    const installGuide = read("INSTALL_CN.md");

    expect(installGuide).toContain(
      '-H "Authorization: Bearer $KNOWLEDGE_SERVICE_KEY"',
    );
    expect(installGuide).not.toMatch(/^KNOWLEDGE_ANALYTICS_ADMIN_KEY=/m);
  });
});
