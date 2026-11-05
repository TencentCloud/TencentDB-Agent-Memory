import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WikiService } from "../store/wiki-service.js";
import type { IKnowledgeStore } from "../store/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createService() {
  const dataRoot = mkdtempSync(join(tmpdir(), "wiki-service-structural-"));
  tempDirs.push(dataRoot);
  const store = {
    getWiki: () => ({ status: "ready" }),
  } as unknown as IKnowledgeStore;
  const service = new WikiService({
    store,
    dataRoot,
    worker: async () => {},
  });
  return { dataRoot, service };
}

describe("WikiService structural page protection", () => {
  it.each([
    "index",
    "INDEX.md",
    "schema",
    "Schema.MD",
    "purpose",
    "PURPOSE.md",
    "log",
    "LOG.md",
    "overview",
    "Overview.MD",
    "wiki/SCHEMA.md",
  ])("rejects page/write to structural ref %s", (ref) => {
    const { service } = createService();

    expect(service.pageWrite("svc", "team", "wiki", ref, "replacement")).toBe("forbidden_path");
  });

  it("rejects page/rm for structural log and leaves it unchanged", async () => {
    const { dataRoot, service } = createService();
    const wikiDir = join(dataRoot, "svc", "team", "wiki", "wiki");
    mkdirSync(wikiDir, { recursive: true });
    const logPath = join(wikiDir, "LOG.md");
    writeFileSync(logPath, "# Important history\n", "utf-8");

    await expect(service.pageRm("svc", "team", "wiki", ["LOG"])).resolves.toBe("forbidden_path");
    expect(readFileSync(logPath, "utf-8")).toBe("# Important history\n");
  });
});
