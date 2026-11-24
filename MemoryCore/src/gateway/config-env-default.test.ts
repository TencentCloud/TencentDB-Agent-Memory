/**
 * Regression: YAML string leaves written as `${NAME:-default}` (the form the
 * shipped tdai-gateway.yaml uses for its Langfuse block) must be expanded
 * from the environment, falling back to `default` when NAME is unset/empty.
 * Previously only the bare `${NAME}` form was expanded, so `${LANGFUSE_HOST:-}`
 * stayed a literal non-empty string and `LANGFUSE_*` env vars were ignored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadGatewayConfig } from "./config.js";

const SHIPPED_YAML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../tdai-gateway.yaml",
);

describe("gateway config ${VAR:-default} expansion", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "tdai-gw-cfg-"));
    vi.stubEnv("TDAI_DATA_DIR", path.join(dir, "data"));
    vi.stubEnv("LANGFUSE_HOST", "");
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("shipped tdai-gateway.yaml picks up LANGFUSE_* from env", () => {
    vi.stubEnv("TDAI_GATEWAY_CONFIG", SHIPPED_YAML);
    vi.stubEnv("LANGFUSE_HOST", "https://langfuse.example.test");
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-test");

    const { langfuse } = loadGatewayConfig().observability;
    expect(langfuse.host).toBe("https://langfuse.example.test");
    expect(langfuse.publicKey).toBe("pk-test");
    expect(langfuse.secretKey).toBe("sk-test");
  });

  it("shipped tdai-gateway.yaml leaves Langfuse unconfigured when env is unset", () => {
    vi.stubEnv("TDAI_GATEWAY_CONFIG", SHIPPED_YAML);

    const { langfuse } = loadGatewayConfig().observability;
    expect(langfuse.host).toBe("");
    expect(langfuse.publicKey).toBe("");
    expect(langfuse.secretKey).toBe("");
  });

  it("uses the default after :- when the variable is unset or empty, and keeps ${NAME} as before", () => {
    const cfg = path.join(dir, "tdai-gateway.yaml");
    writeFileSync(
      cfg,
      [
        "observability:",
        "  langfuse:",
        "    enabled: true",
        '    host: "${TDAI_TEST_LF_HOST:-http://fallback.example.test}"',
        '    publicKey: "${TDAI_TEST_LF_PK:-pk-default}"',
        '    secretKey: "${TDAI_TEST_LF_SK}"',
        "",
      ].join("\n"),
    );
    vi.stubEnv("TDAI_GATEWAY_CONFIG", cfg);
    vi.stubEnv("TDAI_TEST_LF_PK", "");
    vi.stubEnv("TDAI_TEST_LF_SK", "sk-bare");

    const { langfuse } = loadGatewayConfig().observability;
    expect(langfuse.host).toBe("http://fallback.example.test");
    expect(langfuse.publicKey).toBe("pk-default");
    expect(langfuse.secretKey).toBe("sk-bare");
  });
});
