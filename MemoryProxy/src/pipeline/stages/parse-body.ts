/**
 * stages/parse-body.ts — body 解析 stage (Phase 1)。
 *
 * 提取自 4 处近乎相同的代码:
 *   - handler.ts:478-505 (含 PROXY_DEBUG_DUMP_INBOUND dump)
 *   - anthropicHandler.ts:560-565
 *   - codexHandler.ts:328-333
 *   - workbuddyHandler.ts:1126-1131
 *
 * 差异仅在 handler.ts 有 inbound dump; 迁移时保留 (env gate 默认关)。
 * 错误信封由调用方 protocol.buildErrorResponse 生成 (400 Invalid JSON body)。
 */

import type { Context } from "hono";

export type ParseBodyOk = { ok: true; body: Record<string, unknown> };
export type ParseBodyErr = { ok: false; reason: "invalid_json" };
export type ParseBodyResult = ParseBodyOk | ParseBodyErr;

export async function stageParseBody(c: Context): Promise<ParseBodyResult> {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  // Optional inbound dump (dev only) — 与 handler.ts:488 完全一致的语义,
  // env 未设置时零开销。保留在 stage 内部所有 protocol 都受益 (原来只有 handler
  // 有此 dump, codex/wb 缺失, 排障不便)。
  if (process.env.PROXY_DEBUG_DUMP_INBOUND) {
    await dumpInbound(c, body).catch(() => { /* dump 失败不阻塞请求 */ });
  }

  return { ok: true, body };
}

async function dumpInbound(c: Context, body: Record<string, unknown>): Promise<void> {
  try {
    const fs = await import("node:fs");
    const dir = process.env.PROXY_DEBUG_DUMP_INBOUND!;
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const hdrs: Record<string, string> = {};
    for (const [k, v] of c.req.raw.headers.entries()) hdrs[k] = v;
    const sid = hdrs["x-deepseek-harness-session-id"] ?? hdrs["x-session-id"] ?? "nosid";
    const fn = `${dir}/${ts}-${sid}.json`;
    fs.writeFileSync(fn, JSON.stringify({ path: c.req.path, headers: hdrs, body }, null, 2));
    console.log(`[dump-inbound] wrote ${fn}`);
  } catch (e) {
    console.log(`[dump-inbound] error: ${(e as Error).message}`);
  }
}
