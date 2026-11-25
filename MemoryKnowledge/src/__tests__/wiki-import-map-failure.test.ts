import { describe, expect, it, vi } from "vitest";
import { runImport, type WikiServiceLike } from "../wiki-source/import-runner.js";
import type { WikiSourceRegistry } from "../wiki-source/registry.js";
import type { WikiSourceProvider } from "../wiki-source/types.js";

describe("Wiki import name-map persistence", () => {
  it("keeps a successfully written import successful when map persistence fails", async () => {
    const provider: WikiSourceProvider = {
      id: "fake",
      authMethod: {
        kind: "bearer",
        formFields: [{ name: "token", secret: true, required: true }],
      },
      sitePaths: {},
      resolveRoot: async () => ({ rootType: "dir", rootId: "root", displayName: "Root" }),
      listPages: async () => [{
        externalId: "page-1",
        title: "Page One",
        path: "/Page One",
        isDir: false,
      }],
      fetchPage: async () => ({
        externalId: "page-1",
        title: "Page One",
        path: "/Page One",
        markdown: "# Page One",
        fidelity: "lossless",
      }),
    };
    const registry = {
      contextFor: () => ({
        provider,
        ctx: { secret: "token", endpoint: "https://example.test" },
      }),
    } as unknown as WikiSourceRegistry;
    const rawWriteMany = vi.fn().mockResolvedValue([{ filename: "Page One.md", size: 10 }]);
    const wikiService: WikiServiceLike = {
      rawWriteMany,
      readImportNameMap: () => ({}),
      writeImportNameMap: () => {
        throw new Error("disk full");
      },
    };

    const result = await runImport({
      registry,
      wikiService,
      providerId: "fake",
      secret: "token",
      serviceId: "svc",
      teamId: "team",
      wikiId: "wiki",
      sourceUrl: "https://example.test/root",
    });

    expect(result.imported).toBe(1);
    expect(result.failed).toEqual([]);
    expect(result.warnings).toContain("import name map save failed: disk full");
  });
});
