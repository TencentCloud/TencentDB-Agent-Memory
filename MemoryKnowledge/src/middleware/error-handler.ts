/**
 * Error handler middleware — catches unhandled exceptions and returns ApiResponseEnvelope.
 */

import type { Context } from "hono";
import { wrapError } from "../api-helpers.js";
import { createLogger } from "../logger.js";

const log = createLogger("error-handler");

export function errorHandler(err: Error, c: Context): Response {
  const msg = err instanceof Error ? err.message : String(err);
  log.error(`unhandled error: ${msg}`);
  return c.json(wrapError(500, msg), 500);
}
