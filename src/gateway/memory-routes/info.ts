/**
 * GET /memory/info — discovery route for the pi extension.
 *
 * The extension knows only TDAI_GATEWAY_URL (tdai-memory-shared.ts:64), so
 * it fetches the token file path here and reads the credential file itself.
 * Never exposes the token (only the path).
 *
 * Split from memory-routes.ts to keep that file ≤150 lines.
 */

import type http from "node:http";
import { sendJson } from "../http-utils.js";
import type { MemoryInfoResponse } from "../types.js";
import type { MemoryRoutesContext } from "./context.js";

export function handleMemoryInfo(
  ctx: MemoryRoutesContext,
  res: http.ServerResponse,
): void {
  ctx.tokenManager.ensure();
  const response: MemoryInfoResponse = {
    dataDir: ctx.config.data.baseDir,
    tokenPath: ctx.tokenManager.tokenPath,
    version: ctx.version,
  };
  sendJson(res, 200, response);
}
