import { describe, expect, it, vi } from "vitest";

import { runImport, type WikiServiceLike } from "./import-runner.js";
import type { WikiSourceRegistry } from "./registry.js";
import type {
  RemotePageContent,
  RemotePageRef,
  SourceContext,
  WikiSourceProvider,
} from "./types.js";

function createProvider(
  pages: RemotePageRef[],
  contents: RemotePageContent[],
): WikiSourceProvider {
  return {
    id: "test",
    resolveRoot: async () => ({
      rootType: "dir",
      rootId: "root",
      displayName: "Root",
    }),
    listPages: async () => pages,
    fetchPages: async (
      _ctx: SourceContext,
      ids: string[],
    ) => contents.filter((content) => ids.includes(content.externalId)),
  } as unknown as WikiSourceProvider;
}

function createRegistry(provider: WikiSourceProvider): WikiSourceRegistry {
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

function createServiceCapturingWrites(
  captured: Array<{ filename: string; content: string }>,
  nameMap?: Record<string, string>,
): WikiServiceLike {
  return {
    rawWriteMany: vi.fn((_serviceId, _teamId, _wikiId, files) => {
      captured.push(...files);
      return files.map((file) => ({
        filename: file.filename,
        size: Buffer.byteLength(file.content, "utf-8"),
      }));
    }),
    ...(nameMap
      ? {
          readImportNameMap: () => ({ ...nameMap }),
          writeImportNameMap: vi.fn(),
        }
      : {}),
  };
}

function run(
  provider: WikiSourceProvider,
  wikiService: WikiServiceLike,
): ReturnType<typeof runImport> {
  return runImport({
    registry: createRegistry(provider),
    wikiService,
    providerId: "test",
    secret: "test-secret",
    serviceId: "svc-test",
    teamId: "team-test",
    wikiId: "wiki-test",
    sourceUrl: "https://example.invalid/root",
  });
}

describe("wiki import filenames", () => {
  it("avoids collisions between titles that differ only by case", async () => {
    const provider = createProvider(
      [
        { externalId: "page-a", title: "Alpha", path: "Alpha" },
        { externalId: "page-b", title: "alpha", path: "alpha" },
      ],
      [
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
      ],
    );
    const captured: Array<{ filename: string; content: string }> = [];
    const service = createServiceCapturingWrites(captured);

    const result = await run(provider, service);

    expect(result.imported).toBe(2);
    expect(captured.map((file) => file.filename)).toEqual([
      "Alpha.md",
      "alpha-2.md",
    ]);
    expect(
      new Set(
        captured.map((file) =>
          file.filename.normalize("NFC").toLocaleLowerCase("en-US"),
        ),
      ).size,
    ).toBe(2);
  });

  it("reserves historical names case-insensitively", async () => {
    const provider = createProvider(
      [{ externalId: "page-b", title: "alpha", path: "alpha" }],
      [
        {
          externalId: "page-b",
          markdown: "B",
          fidelity: "lossless",
        },
      ],
    );
    const captured: Array<{ filename: string; content: string }> = [];
    const service = createServiceCapturingWrites(captured, {
      "page-a": "Alpha.md",
    });

    const result = await run(provider, service);

    expect(result.imported).toBe(1);
    expect(captured.map((file) => file.filename)).toEqual(["alpha-2.md"]);
  });

  it("treats canonically equivalent Unicode titles as one filename", async () => {
    const decomposedTitle = "Cafe\u0301";
    const provider = createProvider(
      [
        { externalId: "page-a", title: "Café", path: "Café" },
        {
          externalId: "page-b",
          title: decomposedTitle,
          path: decomposedTitle,
        },
      ],
      [
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
      ],
    );
    const captured: Array<{ filename: string; content: string }> = [];
    const service = createServiceCapturingWrites(captured);

    const result = await run(provider, service);

    expect(result.imported).toBe(2);
    expect(captured).toHaveLength(2);
    expect(captured[1].filename).toContain("-2.md");
  });
});
