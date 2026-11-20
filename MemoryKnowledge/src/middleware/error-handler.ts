/**
 * Error handler middleware — catches unhandled exceptions and returns ApiResponseEnvelope.
 */

import type { Context } from "hono";
import { wrapError } from "../api-helpers.js";
import { createLogger } from "../logger.js";

const log = createLogger("error-handler");

export function errorHandler(err: Error, c: Context) {
  if (err instanceof SyntaxError && err.message.includes("JSON")) {
    return c.json(wrapError(400, "malformed JSON"), 400);
  }
  // Caller paths may contain private identifiers; keep this diagnostic fixed.
  log.error("unhandled request error");
  return c.json(wrapError(500, "Internal Server Error"), 500);
}
