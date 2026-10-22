import { describe, expect, it, vi } from "vitest";

import { runImport, type WikiServiceLike } from "./import-runner.js";
import type { WikiSourceRegistry } from "./registry.js";
import type {
  RemotePageContent,
  RemotePageRef,
  SourceContext,
  WikiSourceProvider,
} from "./types.js";

const pages: RemotePageRef[] = [
  { externalId: "page-a", title: "Alpha", path: "Alpha" },
  { externalId: "page-b", title: "Beta", path: "Beta" },
  { externalId: "dir-a", title: "Folder", path: "Folder", isDir: true },
];

const contents: RemotePageContent[] = [
  {
    externalId: "page-a",
    markdown: "A",
    fidelity: "lossless",
  },
  {
    externalId: "page-b",
    markdown: "B",
    fidelity: "lossless",
  },
];

const provider = {
  id: "test",
  resolveRoot: async () => ({
    rootType: "dir",
    rootId: "root",
    displayName: "Root",
  }),
  listPages: async () => pages,
  fetchPages: async (_ctx: SourceContext, ids: string[]) =>
    contents.filter((content) => ids.includes(content.externalId)),
} as unknown as WikiSourceProvider;

function createRegistry(): WikiSourceRegistry {
  return {
    contextFor: () => ({
      provider,
      ctx: {
        secret: "test-secret",
        endpoint: "https://example.invalid",
      },
    }),
  } as unknown as WikiSourceRegistry;
}

function createService(
  captured: Array<{ filename: string; content: string }>,
): WikiServiceLike {
  return {
    rawWriteMany: vi.fn((_serviceId, _teamId, _wikiId, files) => {
      captured.push(...files);
      return files.map((file) => ({
        filename: file.filename,
        size: Buffer.byteLength(file.content, "utf-8"),
      }));
    }),
  };
}

function run(pageIds: string[], captured: Array<{ filename: string; content: string }>) {
  return runImport({
    registry: createRegistry(),
    wikiService: createService(captured),
    providerId: "test",
    secret: "test-secret",
    serviceId: "svc-test",
    teamId: "team-test",
    wikiId: "wiki-test",
    sourceUrl: "https://example.invalid/root",
    pageIds,
  });
}

describe("wiki import explicit page selection", () => {
  it("reports a requested page that disappeared and counts only directories", async () => {
    const captured: Array<{ filename: string; content: string }> = [];

    const result = await run(["page-a", "missing-page"], captured);

    expect(result.imported).toBe(1);
    expect(result.skippedDirs).toBe(1);
    expect(result.failed).toEqual([
      {
        id: "missing-page",
        error: "requested page not found in current source listing",
      },
    ]);
    expect(captured.map((file) => file.filename)).toEqual(["Alpha.md"]);
  });

  it("reports a requested directory id instead of counting it as imported", async () => {
    const captured: Array<{ filename: string; content: string }> = [];

    const result = await run(["dir-a"], captured);

    expect(result.imported).toBe(0);
    expect(result.skippedDirs).toBe(1);
    expect(result.failed).toEqual([
      {
        id: "dir-a",
        error: "requested id is a directory and cannot be imported as a page",
      },
    ]);
    expect(captured).toEqual([]);
  });

  it("does not duplicate writes when a page id is repeated", async () => {
    const captured: Array<{ filename: string; content: string }> = [];

    const result = await run(["page-a", "page-a"], captured);

    expect(result.imported).toBe(1);
    expect(result.failed).toEqual([]);
    expect(captured.map((file) => file.filename)).toEqual(["Alpha.md"]);
  });

  it("keeps an explicit empty selection distinct from an omitted selection", async () => {
    const captured: Array<{ filename: string; content: string }> = [];

    const result = await run([], captured);

    expect(result.imported).toBe(0);
    expect(result.skippedDirs).toBe(1);
    expect(result.failed).toEqual([]);
    expect(captured).toEqual([]);
  });
});
