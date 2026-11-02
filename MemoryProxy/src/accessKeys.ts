/**
 * Optional access keys for a proxy reachable beyond localhost.
 *
 * TDAI_PROXY_ACCESS_KEYS_FILE lists one key per line (`#` starts a comment).
 * When it is set, every route except /health needs one of those keys as
 * `Authorization: Bearer <key>` or `x-api-key: <key>`. The handlers then swap
 * the header for `upstream.apiKey`, so callers never hold the upstream key.
 * The file is re-read when its mtime changes, so keys can be added or revoked
 * without a restart.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { MiddlewareHandler } from "hono";

export function parseAccessKeys(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
}

export function presentedKeys(headers: Headers): string[] {
  const bearer = /^Bearer\s+(.+)$/i.exec((headers.get("authorization") ?? "").trim())?.[1];
  return [bearer, headers.get("x-api-key") ?? undefined]
    .map((key) => key?.trim() ?? "")
    .filter(Boolean);
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export function isAllowed(presented: string[], keys: string[]): boolean {
  let ok = false;
  for (const candidate of presented) {
    const d = digest(candidate);
    for (const key of keys) ok = timingSafeEqual(d, digest(key)) || ok;
  }
  return ok;
}

export function accessKeyMiddleware(path: string): MiddlewareHandler {
  let mtimeMs = -1;
  let keys: string[] = [];
  const load = (): string[] => {
    const { mtimeMs: current } = statSync(path);
    if (current !== mtimeMs) {
      keys = parseAccessKeys(readFileSync(path, "utf8"));
      mtimeMs = current;
    }
    return keys;
  };
  load();

  return async (c, next) => {
    if (c.req.path === "/health") return next();
    let current = keys;
    try {
      current = load();
    } catch {
      // Keep the last good list if the file is briefly missing mid-rewrite.
    }
    if (!isAllowed(presentedKeys(c.req.raw.headers), current)) {
      return c.json(
        { error: { type: "authentication_error", message: "invalid or missing proxy access key" } },
        401,
      );
    }
    await next();
  };
}
