/**
 * P1 回归验证：同一 user key 下两个本应独立的 dsh（pi-ai 无会话头）会话
 * 不得共享同一个 session id / memory grouping。
 *
 * 用法（review 同款）：
 *   cd MemoryProxy && npx tsx ../evidence/repro-headerless-dsh-session-sharing.ts
 *
 * 期望（修复后）：requestA != requestB，sameSession=false。
 * 修复前该脚本输出 {"requestA":"key-user","requestB":"key-user","sameSession":true}。
 */
import {
  resolveConversationId,
  resolveDshFallbackConversationId,
} from "../MemoryProxy/src/session/session-key.js";

/** Minimal Hono Context stub — resolveConversationId only uses req.header. */
type FakeContext = { req: { header: (name: string) => string | null } };
function fakeContext(headers: Record<string, string>): FakeContext {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { req: { header: (name: string) => lower[name.toLowerCase()] ?? null } };
}

/** 模拟 handler.ts 的会话标识解析：header 优先，dsh 兜底派生，否则 fail-closed(null)。 */
function resolveConversation(
  headers: Record<string, string>,
  messages: Array<{ role?: string; content?: unknown }>,
): string | null {
  const c = fakeContext(headers);
  let conversationId = resolveConversationId(c);
  if (!conversationId) conversationId = resolveDshFallbackConversationId("dsh", messages);
  return conversationId;
}

const KEY_ID = "key-user"; // 同一个 user key

// 两个本应独立的 dsh 会话：无会话头（pi-ai 默认流量，只有 x-stainless-*）
const piAiHeaders = { "x-stainless-arch": "x64", "x-stainless-lang": "js" };

const requestA = resolveConversation(piAiHeaders, [
  { role: "system", content: "You are a coding agent." },
  { role: "user", content: `修一下 ${KEY_ID} 项目的登录 bug` },
]);

const requestB = resolveConversation(piAiHeaders, [
  { role: "system", content: "You are a coding agent." },
  { role: "user", content: `Write a haiku about ${KEY_ID} the ocean` },
]);

// 同会话第二轮（历史增长）→ 标识必须不变
const requestA2 = resolveConversation(piAiHeaders, [
  { role: "system", content: "You are a coding agent." },
  { role: "user", content: `修一下 ${KEY_ID} 项目的登录 bug` },
  { role: "assistant", content: "好的" },
  { role: "user", content: "<system-reminder>…</system-reminder>" },
]);

const result = {
  requestA,
  requestB,
  sameSession: requestA === requestB,
  sameConversationAcrossTurns: requestA === requestA2,
  memoryGroupA: requestA ? `dsh:${requestA}` : null,
  memoryGroupB: requestB ? `dsh:${requestB}` : null,
};
console.log(JSON.stringify(result));

if (requestA === requestB || requestA !== requestA2) {
  console.error("P1 still present: sessions shared / unstable");
  process.exit(1);
}
console.error("OK: per-conversation isolation holds");
