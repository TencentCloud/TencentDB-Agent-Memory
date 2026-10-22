import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WikiService } from "./wiki-service.js";

const fsFailure = vi.hoisted(() => ({ failNextWrite: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (
      path: Parameters<typeof actual.writeFileSync>[0],
      data: Parameters<typeof actual.writeFileSync>[1],
      options?: Parameters<typeof actual.writeFileSync>[2],
    ) => {
      if (fsFailure.failNextWrite) {
        fsFailure.failNextWrite = false;
        actual.writeFileSync(path, String(data).slice(0, 12), options);
        throw new Error("simulated process interruption");
      }
      return actual.writeFileSync(path, data, options);
    },
  };
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeService(): WikiService {
  const root = mkdtempSync(join(tmpdir(), "wiki-import-map-"));
  roots.push(root);
  return new WikiService({
    store: {} as any,
    dataRoot: root,
    worker: {} as any,
  });
}

describe("WikiService import name map", () => {
  it("keeps the previous valid map when replacing it is interrupted", () => {
    const service = makeService();
    const mapPath = join(service.dirFor("service", "team", "wiki"), "import-map.json");
    mkdirSync(join(service.dirFor("service", "team", "wiki")), { recursive: true });
    writeFileSync(mapPath, JSON.stringify({
      version: 1,
      providers: {
        existing: { source: "existing.md" },
      },
    }));

    fsFailure.failNextWrite = true;
    service.writeImportNameMap("service", "team", "wiki", "incoming", {
      source: "incoming.md",
    });

    expect(existsSync(mapPath)).toBe(true);
    expect(JSON.parse(readFileSync(mapPath, "utf8"))).toEqual({
      version: 1,
      providers: {
        existing: { source: "existing.md" },
      },
    });

    service.writeImportNameMap("service", "team", "wiki", "incoming", {
      source: "incoming.md",
    });

    expect(JSON.parse(readFileSync(mapPath, "utf8"))).toEqual({
      version: 1,
      providers: {
        existing: { source: "existing.md" },
        incoming: { source: "incoming.md" },
      },
    });
  });
});
