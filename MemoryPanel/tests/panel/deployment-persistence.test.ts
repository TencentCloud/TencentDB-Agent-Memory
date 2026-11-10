import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

describe("Panel deployment persistence", () => {
  it("keeps IdP identity bindings on the mounted data volume", () => {
    const dockerfile = read("deploy/panel-knowledge-combined/Dockerfile");
    const hubLauncher = read("deploy/global-images/start-memory-hub.sh");

    expect(dockerfile).toContain(
      "PANEL_AUTH_IDENTITY_STORE_PATH=/data/knowledge/panel-auth-identities.json",
    );
    expect(hubLauncher).toContain(
      'PANEL_AUTH_IDENTITY_STORE_PATH="${PANEL_AUTH_IDENTITY_STORE_PATH:-/data/knowledge/panel-auth-identities.json}"',
    );
  });

  it("keeps Proxy session SQLite state on a named volume", () => {
    const proxyLauncher = read("deploy/global-images/start-proxy.sh");
    const stopAll = read("deploy/global-images/stop-all.sh");

    expect(proxyLauncher).toContain(
      'PROXY_DATA_VOLUME="${PROXY_DATA_VOLUME:-tdai-proxy-data}"',
    );
    expect(proxyLauncher).toContain(
      '-v "${PROXY_DATA_VOLUME}:/data/tdai-memory-proxy"',
    );
    expect(stopAll).toContain(
      '"$PROXY_DATA_VOLUME" mongo-local-db mongo-local-configdb mongo-local-mongot',
    );
  });
});
