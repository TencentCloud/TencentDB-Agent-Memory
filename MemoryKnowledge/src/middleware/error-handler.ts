/**
 * Error handler middleware — catches unhandled exceptions and returns ApiResponseEnvelope.
 *
 * 原始 err.message 会**同时**进入响应体与错误日志，因此这里必须先脱敏：
 * 上游（git 等）的错误信息会原样回显 URL，历史写法允许 URL 内嵌凭证。
 */

import type { Context } from "hono";
import { wrapError } from "../api-helpers.js";
import { createLogger } from "../logger.js";
import { sanitizeGitError } from "../utils/sanitize.js";

const log = createLogger("error-handler");

export function errorHandler(err: Error, c: Context) {
  const msg = sanitizeGitError(err instanceof Error ? err.message : String(err), undefined, 0);
  log.error(`unhandled error: ${msg}`);
  return c.json(wrapError(500, msg), 500);
}
