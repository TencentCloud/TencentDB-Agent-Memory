import { describe, expect, it, vi } from "vitest";
import { runImport, type WikiServiceLike } from "../wiki-source/import-runner.js";
import type { WikiSourceRegistry } from "../wiki-source/registry.js";
import type { RemotePageContent, WikiSourceProvider } from "../wiki-source/types.js";

function setup(contents: RemotePageContent[]) {
  const provider: WikiSourceProvider = {
    id: "fake",
    authMethod: {
      kind: "bearer",
      formFields: [{ name: "token", secret: true, required: true }],
    },
    sitePaths: {},
    resolveRoot: async () => ({ rootType: "dir", rootId: "root", displayName: "Root" }),
    listPages: async () => contents.map(({ externalId, title, isDir }) => ({
      externalId,
      title,
      path: `/${title}`,
      isDir,
    })),
    fetchPage: async (_ctx, id) => {
      const found = contents.find((item) => item.externalId === id);
      if (!found) throw new Error(`missing ${id}`);
      return found;
    },
  };
  const registry = {
    contextFor: () => ({
      provider,
      ctx: { secret: "token", endpoint: "https://example.test" },
    }),
  } as unknown as WikiSourceRegistry;
  const rawWriteMany = vi.fn().mockImplementation((_s, _t, _w, files) =>
    files.map(({ filename }) => ({ filename, size: 1 })),
  );
  const wikiService: WikiServiceLike = { rawWriteMany };
  return { registry, wikiService };
}

function page(externalId: string, title: string, markdown: string): RemotePageContent {
  return {
    externalId,
    title,
    path: `/${title}`,
    markdown,
    fidelity: "lossless",
  };
}

describe("Wiki import empty content", () => {
  it("reports empty pages as failures and still writes non-empty pages", async () => {
    const { registry, wikiService } = setup([
      page("empty", "Empty", " \r\n\t"),
      page("valid", "Valid", "# Valid\n\ncontent"),
    ]);

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
    expect(result.failed).toEqual([{ id: "empty", error: "empty markdown" }]);
    expect(wikiService.rawWriteMany).toHaveBeenCalledTimes(1);
    expect(wikiService.rawWriteMany).toHaveBeenCalledWith(
      "svc",
      "team",
      "wiki",
      [{ filename: "Valid.md", content: "# Valid\n\ncontent" }],
    );
  });

  it("does not silently drop a zero-length page", async () => {
    const { registry, wikiService } = setup([page("empty", "Empty", "")]);

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

    expect(result.imported).toBe(0);
    expect(result.failed).toEqual([{ id: "empty", error: "empty markdown" }]);
    expect(wikiService.rawWriteMany).not.toHaveBeenCalled();
  });
});
