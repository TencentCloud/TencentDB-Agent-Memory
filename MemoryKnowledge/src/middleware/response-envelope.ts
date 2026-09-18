/**
 * Response envelope middleware — adds access logging + request_id tracking.
 *
 * All responses are wrapped in ApiResponseEnvelope by route handlers directly
 * (via wrapOk / wrapError). This middleware handles access logging and
 * generates a request_id header if not provided.
 */

import type { MiddlewareHandler } from "hono";
import { createLogger } from "../logger.js";

const log = createLogger("http");

const MAX_BODY_LOG = 500;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `…[+${s.length - max}]`;
}

/** 提取 request body 的关键字段（避免打全量，只打 ID 类字段便于关联）。 */
function pickReqFields(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const b = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ['wiki_id', 'code_graph_id', 'knowledge_id', 'wiki_ids', 'code_graph_ids', 'knowledge_ids', 'team_id', 'repo_url', 'branch', 'filename', 'filenames', 'refs', 'tool_name', 'query', 'path']) {
    if (k in b) out[k] = b[k];
  }
  return out;
}

export function accessLog(): MiddlewareHandler {
  return async (c, next) => {
    const t0 = Date.now();
    const route = `${c.req.method} ${c.req.path}`;

    // Generate request_id if not provided
    const requestId = c.req.header("x-request-id") || crypto.randomUUID();
    c.set("requestId", requestId);

    // 缓存 request body（body 只能读一次，失败时用于日志）
    // 注意：c.req.text() 内部已把 body 缓存为 Promise（bodyCache），后续 handler 的
    // c.req.json()/text() 会复用该缓存，手动写入本就是多余的；且 Hono 发布类型中
    // text 为 string，赋 Promise 会报 TS2322，故不要手动写 bodyCache。
    let reqBody: unknown = undefined;
    if (c.req.method === 'POST' || c.req.method === 'PUT') {
      try {
        const raw = await c.req.text();
        reqBody = raw ? JSON.parse(raw) : undefined;
      } catch {
        // 非 JSON body，忽略
      }
    }

    await next();

    const ms = Date.now() - t0;
    const status = c.res.status;
    log.info(`${route} → ${status} (${ms}ms)`);

    if (status >= 400) {
      // 失败时打 request 关键字段 + response body（截断）
      const fields = pickReqFields(reqBody);
      const logExtra: Record<string, unknown> = { status, ...fields };

      try {
        const respText = await c.res.text();
        logExtra.responseBody = truncate(respText, MAX_BODY_LOG);
        // 重建 response（text() 消费了 body）
        c.res = new Response(respText, {
          status: c.res.status,
          headers: c.res.headers,
        });
      } catch {
        // response body 读不了就算了
      }

      log.warn(`${route} error`, logExtra);
    }
  };
}
