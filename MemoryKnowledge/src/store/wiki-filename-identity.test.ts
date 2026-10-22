import { describe, expect, it } from "vitest";

import {
  filenameCollisionKey,
  findDuplicateWikiFilename,
} from "./wiki-filename-identity.js";
import { WikiService } from "./wiki-service.js";
import type { IKnowledgeStore, WikiRow } from "./types.js";

function createService(): WikiService {
  const row = {
    wiki_id: "wiki-test",
    service_id: "svc-test",
    team_id: "team-test",
    status: "ready",
  } as unknown as WikiRow;
  const store = {
    getWiki: () => row,
  } as unknown as IKnowledgeStore;
  return new WikiService({
    store,
    dataRoot: "D:/tmp/wiki-filename-identity-test",
    worker: async () => {},
  });
}

describe("wiki filename identity", () => {
  it("folds case and Unicode normalization", () => {
    expect(filenameCollisionKey("Café.MD")).toBe(
      filenameCollisionKey("Cafe\u0301.md"),
    );
  });

  it("finds exact duplicates", () => {
    expect(findDuplicateWikiFilename(["Notes.md", "Notes.md"])).toBe("Notes.md");
  });

  it("finds case-only duplicates", () => {
    expect(findDuplicateWikiFilename(["Alpha.md", "alpha.md"])).toBe("alpha.md");
  });

  it("finds canonically equivalent Unicode duplicates", () => {
    expect(
      findDuplicateWikiFilename(["Café.md", "Cafe\u0301.md"]),
    ).toBe("Cafe\u0301.md");
  });

  it("accepts distinct portable names", () => {
    expect(findDuplicateWikiFilename(["Alpha.md", "beta.md"])).toBeNull();
  });

  it("rejects duplicate raw filenames before touching the filesystem", () => {
    const service = createService();

    expect(
      service.rawWriteMany("svc-test", "team-test", "wiki-test", [
        { filename: "Alpha.md", content: "first" },
        { filename: "alpha.md", content: "second" },
      ]),
    ).toBe("duplicate_filename");
  });

  it("rejects page refs that resolve to the same markdown filename", () => {
    const service = createService();

    expect(
      service.pageWriteMany("svc-test", "team-test", "wiki-test", [
        { ref: "Guide", content: "first" },
        { ref: "guide.md", content: "second" },
      ]),
    ).toBe("duplicate_filename");
  });
});
