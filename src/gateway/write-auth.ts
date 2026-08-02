/**
 * Write-gate for memory mutation routes (wave tdai-memory-subagents-2026-08-02).
 *
 * The gate accepts EITHER credential — alternative, NOT stacked on top of the
 * existing checkAuth (which is Bearer-only, server.ts:345):
 *
 *   1. `Authorization: Bearer <apiKey>` — only valid when a server.apiKey is
 *      configured. When no apiKey is set (legacy open mode), the Bearer path
 *      is skipped entirely: an unconfigured secret cannot be a valid secret.
 *   2. `x-memory-token: <loopbackToken>` — always configured (generated at
 *      gateway startup). This is the credential the pi extension uses.
 *
 * Both comparisons are constant-time. Missing or mismatching credentials => 401.
 */

import type { IncomingHttpHeaders } from "node:http";
import { safeEqual } from "./http-utils.js";

/**
 * Evaluate the write-gate for a request.
 *
 * @param headers  Request headers (Node lowercases header names).
 * @param expectedApiKey  Configured `server.apiKey` (undefined = not configured).
 * @param loopbackToken   The gateway's loopback memory token (always present).
 * @returns `true` when either credential matches; `false` otherwise.
 */
export function checkWriteAuth(
  headers: IncomingHttpHeaders,
  expectedApiKey: string | undefined,
  loopbackToken: string,
): boolean {
  // Path 1: Bearer apiKey (only meaningful when an apiKey is configured).
  const authz = headers["authorization"];
  if (expectedApiKey && typeof authz === "string" && authz.startsWith("Bearer ")) {
    const provided = authz.slice("Bearer ".length).trim();
    if (provided && safeEqual(provided, expectedApiKey)) return true;
  }

  // Path 2: loopback memory token (always configured).
  const token = headers["x-memory-token"];
  if (typeof token === "string") {
    const provided = token.trim();
    if (provided && safeEqual(provided, loopbackToken)) return true;
  }

  return false;
}
