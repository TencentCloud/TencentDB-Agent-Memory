import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerOffload, isSafeRefPath, resolveReadMaxTokens, sliceRefContent } from "./index.js";
import { createStorageContext, ensureDirs, writeRefMd } from "./storage.js";

function createToolApi() {
  const tools: any[] = [];
  const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  return {
    api: {
      config: {},
      logger,
      registerTool: (tool: any) => tools.push(tool),
    },
    tools,
  };
}

describe("sliceRefContent", () => {
  it("returns the query hit from an oversized single-line ref payload", () => {
    const before = Array.from({ length: 400 }, (_, i) => `TDAI_OFFLOAD_SENTINEL ${i} ${"X".repeat(80)}`).join("\\n");
    const hit = `TDAI_OFFLOAD_SENTINEL 400 ${"X".repeat(80)}`;
    const after = Array.from({ length: 49 }, (_, i) => `TDAI_OFFLOAD_SENTINEL ${401 + i} ${"X".repeat(80)}`).join("\\n");
    const raw = `# Tool Result\n\n~~~json\n{"aggregated":"${before}\\n${hit}\\n${after}"}\n~~~`;

    const sliced = sliceRefContent(raw, {
      query: "TDAI_OFFLOAD_SENTINEL 400",
      maxTokens: 1200,
    });

    expect(sliced).toContain("TDAI_OFFLOAD_SENTINEL 400");
    expect(sliced).not.toBe("[truncated: max_tokens=1200]");
  });
});

describe("isSafeRefPath", () => {
  it("accepts a single refs filename and rejects traversal", () => {
    expect(isSafeRefPath("refs/tool-result.md")).toBe(true);
    expect(isSafeRefPath("refs/../secret.md")).toBe(false);
    expect(isSafeRefPath("refs/nested/result.md")).toBe(false);
    expect(isSafeRefPath("C:\\secret.md")).toBe(false);
  });
});

describe("tdai_offload_read", () => {
  it("rejects calls that do not provide an explicit session key", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "tdai-offload-read-"));
    try {
      const { api, tools } = createToolApi();
      registerOffload(api, { mode: "collect", dataDir: dataRoot } as any);
      const readTool = tools.find((tool) => tool.name === "tdai_offload_read");

      await expect(readTool.execute("call-1", { result_ref: "refs/tool-result.md" }, {}))
        .resolves.toBe("tdai_offload_read: an explicit sessionKey is required.");

      const sessionKey = "agent:main:session-1";
      const ctx = createStorageContext(dataRoot, "main", "session-1");
      await ensureDirs(ctx);
      const ref = await writeRefMd(ctx, "2026-07-10T00:00:00.000Z", "exec", "owned session content", "call-1");

      await expect(readTool.execute("call-2", { result_ref: ref }, { sessionKey }))
        .resolves.toContain("owned session content");
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});

describe("resolveReadMaxTokens", () => {
  it("caps the requested read size at the configured hard limit", () => {
    expect(resolveReadMaxTokens(10_000, 256)).toBe(256);
  });
});
