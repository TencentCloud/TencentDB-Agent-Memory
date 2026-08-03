import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const specPath = new URL("../../docs/api/openapi.yaml", import.meta.url);

const mountedPaths = [
  "/health",
  "/v3/wiki/create",
  "/v3/wiki/list",
  "/v3/wiki/get",
  "/v3/wiki/update-meta",
  "/v3/wiki/ingest",
  "/v3/wiki/delete",
  "/v3/wiki/raw/ls",
  "/v3/wiki/raw/read",
  "/v3/wiki/raw/write",
  "/v3/wiki/raw/rm",
  "/v3/wiki/page/ls",
  "/v3/wiki/page/read",
  "/v3/wiki/page/write",
  "/v3/wiki/page/rm",
  "/v3/wiki/graph",
  "/v3/wiki/search",
  "/v3/code-graph/create",
  "/v3/code-graph/list",
  "/v3/code-graph/get",
  "/v3/code-graph/update-meta",
  "/v3/code-graph/sync",
  "/v3/code-graph/delete",
  "/v3/code-graph/search",
  "/v3/code-graph/explore",
  "/v3/code-graph/callers",
  "/v3/code-graph/callees",
  "/v3/code-graph/impact",
  "/v3/code-graph/node",
  "/v3/code-graph/status",
  "/v3/code-graph/files",
  "/v3/tools/list",
  "/v3/tools/call",
  "/v3/internal/llm-binding/set",
  "/v3/internal/llm-binding/status",
  "/v3/internal/llm-binding/list",
] as const;

describe("Knowledge OpenAPI contract", () => {
  it("is valid YAML and documents every mounted HTTP path", () => {
    const document = parse(readFileSync(specPath, "utf8")) as {
      openapi?: string;
      paths?: Record<string, unknown>;
    };

    expect(document.openapi).toMatch(/^3\./);
    expect(Object.keys(document.paths ?? {}).sort()).toEqual([...mountedPaths].sort());
  });

  it("matches the Docker and repository documentation runtime path", () => {
    const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
    const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const readmeCn = readFileSync(new URL("../../../README_CN.md", import.meta.url), "utf8");

    expect(dockerfile).toContain("COPY docs/api/openapi.yaml ./docs/api/openapi.yaml");
    expect(readme).toContain("./MemoryKnowledge/docs/api/openapi.yaml");
    expect(readmeCn).toContain("./MemoryKnowledge/docs/api/openapi.yaml");
  });
});
