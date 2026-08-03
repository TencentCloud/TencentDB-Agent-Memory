/**
 * GET /memory/records — L1 records with filters (since / project / type).
 *
 * Split from memory-routes.ts to keep that file ≤150 lines.
 */

import type http from "node:http";
import { sendJson, sendError } from "../http-utils.js";
import type {
  MemoryRecordsResponse,
  MemoryRecordRow,
} from "../types.js";
import type { MemoryRoutesContext } from "./context.js";
import { queryL1Rows, clampInt } from "./helpers.js";

export async function handleMemoryRecords(
  ctx: MemoryRoutesContext,
  url: URL,
  res: http.ServerResponse,
): Promise<void> {
  const since = url.searchParams.get("since") ?? undefined;
  const project = url.searchParams.get("project") ?? undefined;
  const type = url.searchParams.get("type") ?? undefined;
  const limit = clampInt(url.searchParams.get("limit"), 1, 1000, 200);

  const rows = queryL1Rows(ctx.config.data.baseDir, ctx.logger, {
    since,
    project,
    type,
    limit,
  });
  if (!rows) {
    sendError(res, 500, "memory records query failed");
    return;
  }
  const response: MemoryRecordsResponse = {
    total: rows.length,
    records: rows as unknown as MemoryRecordRow[],
  };
  sendJson(res, 200, response);
}
