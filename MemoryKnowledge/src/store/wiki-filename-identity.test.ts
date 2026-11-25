import { describe, expect, it } from "vitest";

import {
  filenameCollisionKey,
  findDuplicateWikiFilename,
  isPortableWikiFilename,
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

  it("folds path-equivalent names", () => {
    expect(filenameCollisionKey("./nested//Alpha.md")).toBe(
      filenameCollisionKey("nested/alpha.md"),
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

  it("finds path-equivalent duplicates", () => {
    expect(
      findDuplicateWikiFilename([
        "nested/Alpha.md",
        "./nested//alpha.md",
      ]),
    ).toBe("./nested//alpha.md");
  });

  it("accepts distinct portable names", () => {
    expect(findDuplicateWikiFilename(["Alpha.md", "beta.md"])).toBeNull();
  });

  it("rejects Windows reserved device names in any path segment", () => {
    expect(isPortableWikiFilename("CON.md")).toBe(false);
    expect(isPortableWikiFilename("nested/AUX.txt")).toBe(false);
    expect(isPortableWikiFilename("nested/COM1.markdown")).toBe(false);
    expect(isPortableWikiFilename("nested/COM10.md")).toBe(true);
    expect(isPortableWikiFilename("bad:name.md")).toBe(false);
    expect(isPortableWikiFilename("trailing.md ")).toBe(false);
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

  it("rejects Windows reserved raw filenames before touching the filesystem", () => {
    const service = createService();

    expect(
      service.rawWriteMany("svc-test", "team-test", "wiki-test", [
        { filename: "CON.md", content: "unsafe" },
      ]),
    ).toBe("unsafe_filename");
  });

  it("rejects raw filenames that collide after path normalization", () => {
    const service = createService();

    expect(
      service.rawWriteMany("svc-test", "team-test", "wiki-test", [
        { filename: "nested/Alpha.md", content: "first" },
        { filename: "./nested//alpha.md", content: "second" },
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

  it("rejects Windows reserved page refs", () => {
    const service = createService();

    expect(
      service.pageWriteMany("svc-test", "team-test", "wiki-test", [
        { ref: "nested/NUL", content: "unsafe" },
      ]),
    ).toBe("unsafe_filename");
  });

  it("rejects page refs that collide after removing dot segments", () => {
    const service = createService();

    expect(
      service.pageWriteMany("svc-test", "team-test", "wiki-test", [
        { ref: "nested/Guide", content: "first" },
        { ref: "./nested//guide.md", content: "second" },
      ]),
    ).toBe("duplicate_filename");
  });
});
