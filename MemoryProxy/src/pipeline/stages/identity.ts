/**
 * stages/identity.ts — identity 埋点 stage (Phase 4 stage 化)。
 *
 * 提取自 openai-chat / anthropic 各一处的 inspectAndRecord 调用。
 * 老 codex/wb 缺失 (handler-audit bug B5, P1) — 后续如需修 bug 只需在
 * codex/wb runner 加同一行调用。
 *
 * 语义: fire-and-forget, 绝不阻塞业务流。
 */

import type { Context } from "hono";
import { inspectAndRecord } from "../../identity.js";

export function stageIdentity(
  c: Context,
  body: Record<string, unknown>,
  agentSource: string,
): void {
  const reqHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    reqHeaders[k] = v;
  }
  try {
    inspectAndRecord("POST", c.req.path, reqHeaders, body, agentSource);
  } catch {
    // fire-and-forget: 绝不阻塞业务
  }
}
