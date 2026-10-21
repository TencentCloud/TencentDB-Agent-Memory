/**
 * Response envelope middleware — access logging + request_id tracking.
 * Route handlers wrap responses directly. Access logs use registered route
 * templates and status/timing only, without consuming request/response bodies.
 */

import type { MiddlewareHandler } from "hono";
import { createLogger } from "../logger.js";

const log = createLogger("http");

export function accessLog(): MiddlewareHandler {
  return async (c, next) => {
    const t0 = Date.now();
    const requestId = c.req.header("x-request-id") || crypto.randomUUID();
    c.set("requestId", requestId);

    await next();

    // A registered template may contain parameter names, but never the
    // caller's path values. Unmatched requests must not fall back to req.path.
    const route = `${c.req.method} ${c.req.routePath || "<unmatched>"}`;
    const status = c.res.status;
    log.info(`${route} → ${status} (${Date.now() - t0}ms)`);
    if (status >= 400 && status !== 401) {
      log.warn(`${route} error`, { status });
    }
  };
}
