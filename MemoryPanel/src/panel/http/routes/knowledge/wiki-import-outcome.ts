import type { WikiSourceImportResult } from "../../../kernel/ports/knowledge-client-port.js";

export interface WikiImportOutcome {
  shouldIngest: boolean;
  rawPersisted: boolean;
  importResult?: WikiSourceImportResult;
  errorMessage?: string;
}

/**
 * Decide whether the composite import-and-ingest operation may continue after
 * writing external source pages.
 *
 * Partial imports are safe to ingest because the successfully fetched pages
 * are already durable. A zero-page import must stop before ingest and expose
 * the source errors instead of reporting success over unchanged raw data.
 */
export function assessWikiSourceImport(result: WikiSourceImportResult): WikiImportOutcome {
  if (result.imported > 0) {
    return {
      shouldIngest: true,
      rawPersisted: true,
      importResult: result,
    };
  }

  if (result.failed.length > 0) {
    const detail = result.failed
      .slice(0, 5)
      .map((item) => `${item.id}: ${item.error}`)
      .join("; ");
    const suffix = result.failed.length > 5 ? `; and ${result.failed.length - 5} more` : "";
    return {
      shouldIngest: false,
      rawPersisted: false,
      errorMessage: `all requested pages failed to import (${result.failed.length}): ${detail}${suffix}`,
    };
  }

  return {
    shouldIngest: false,
    rawPersisted: false,
    errorMessage: "no importable pages were found in the selected source",
  };
}
