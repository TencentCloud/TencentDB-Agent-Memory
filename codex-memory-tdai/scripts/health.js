#!/usr/bin/env node
/**
 * Codex SessionStart hook: verify the TdaiGateway is reachable.
 * Fails silently (no output, exit 0) so session start is never blocked.
 *
 * Zero-dependency Node.js (no bash/jq/curl) so the hook runs on any
 * platform Codex runs on — Windows included.
 */

const GATEWAY = process.env.TDAI_GATEWAY_URL || "http://127.0.0.1:8420";

try {
  await fetch(new URL("/health", GATEWAY), { signal: AbortSignal.timeout(5000) });
} catch {
  // Gateway down — stay silent, never block session start.
}
process.exit(0);
