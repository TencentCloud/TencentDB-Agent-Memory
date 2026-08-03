/**
 * GET /memory/validate — sizes + JSON integrity + META frontmatter + vec-meta count.
 *
 * The integrity checks (checkJsonIntegrity, checkSceneMeta, checkVecMetaCounts)
 * live in validate-checks.ts; this file is the route handler.
 *
 * Split from memory-routes.ts to keep that file ≤150 lines.
 */

import type http from "node:http";
import { sendJson } from "../http-utils.js";
import type { MemoryValidateResponse } from "../types.js";
import type { MemoryRoutesContext } from "./context.js";
import { collectBlockStats } from "./blocks.js";
import {
  checkJsonIntegrity,
  checkSceneMeta,
  checkVecMetaCounts,
} from "./validate-checks.js";

export async function handleMemoryValidate(
  ctx: MemoryRoutesContext,
  _url: URL,
  res: http.ServerResponse,
): Promise<void> {
  const dataDir = ctx.config.data.baseDir;

  const { blocks, overLimit } = collectBlockStats(dataDir);
  const response: MemoryValidateResponse = {
    dataDir,
    checks: {
      sizes: { checked: blocks.length, overLimit },
      json: checkJsonIntegrity(dataDir),
      meta: checkSceneMeta(dataDir),
      vecMeta: checkVecMetaCounts(dataDir),
    },
  };
  sendJson(res, 200, response);
}
