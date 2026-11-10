import { describe, expect, it } from "vitest";

import { assessWikiSourceImport } from "../src/panel/http/routes/knowledge/wiki-import-outcome.js";

describe("assessWikiSourceImport", () => {
  it("continues to ingest after a partial import and preserves the summary", () => {
    const result = {
      imported: 2,
      skippedDirs: 1,
      failed: [{ id: "page-c", error: "download failed" }],
      warnings: ["one warning"],
    };

    expect(assessWikiSourceImport(result)).toEqual({
      shouldIngest: true,
      rawPersisted: true,
      importResult: result,
    });
  });

  it("blocks ingest when every requested page failed", () => {
    const assessment = assessWikiSourceImport({
      imported: 0,
      skippedDirs: 1,
      failed: [
        { id: "page-a", error: "requested page not found" },
        { id: "page-b", error: "download failed" },
      ],
      warnings: [],
    });

    expect(assessment.shouldIngest).toBe(false);
    expect(assessment.rawPersisted).toBe(false);
    expect(assessment.errorMessage).toContain("2");
    expect(assessment.errorMessage).toContain("page-a");
    expect(assessment.errorMessage).toContain("page-b");
  });

  it("blocks ingest when no importable page was returned", () => {
    const assessment = assessWikiSourceImport({
      imported: 0,
      skippedDirs: 3,
      failed: [],
      warnings: [],
    });

    expect(assessment).toEqual({
      shouldIngest: false,
      rawPersisted: false,
      errorMessage: "no importable pages were found in the selected source",
    });
  });
});
