/**
 * Regression guard for `RequestLogEntry.traceId`.
 *
 * `codexHandler.ts` logs the codex turn with a `traceId`:
 *
 *     writeLog(config, {
 *       timestamp: startTime,
 *       event: "request",
 *       modelId, keyId, sessionKey: keyId, upstreamUrl, stream: true,
 *       traceId,          // ← TS2353: not a known property of RequestLogEntry
 *     });
 *
 * `traceId` is the proxy's own per-request correlation id (`uuidv7()` at
 * codexHandler.ts:282) — the same value handed to `createPipeline` and to
 * Langfuse. It is NOT `upstreamRequestId`, which is the id the *upstream*
 * returns; both are legitimate and independent.
 *
 * The field already reaches disk at runtime, because `writeLog` serialises the
 * whole entry (`JSON.stringify(entry)`) into the daily JSONL log — so this is
 * purely a missing declaration, not missing behaviour. Declaring it makes the
 * correlation id part of the contract instead of an undeclared extra.
 *
 * ClickHouse ingestion does not carry `traceId` (its schema has no such
 * column), so the field is documented as JSONL-only to prevent someone
 * assuming it is queryable.
 */

import { describe, expect, it } from "vitest";
import type { RequestLogEntry } from "../types.js";

describe("RequestLogEntry declares traceId", () => {
  it("accepts traceId on a request log entry", () => {
    const entry: RequestLogEntry = {
      timestamp: "2026-09-22T00:00:00.000Z",
      event: "request",
      modelId: "gpt-5-codex",
      keyId: "k-1",
      sessionKey: "k-1",
      upstreamUrl: "https://api.example.com/v1/responses",
      stream: true,
      traceId: "018f-test-trace",
    };

    expect(entry.traceId).toBe("018f-test-trace");
  });

  it("stays optional — entries without it still type-check", () => {
    const entry: RequestLogEntry = {
      timestamp: "2026-09-22T00:00:00.000Z",
      event: "request",
      modelId: "gpt-5-codex",
      keyId: "k-1",
      upstreamUrl: "https://api.example.com/v1/responses",
      stream: false,
    };

    expect(entry.traceId).toBeUndefined();
  });

  it("is independent of upstreamRequestId", () => {
    // The proxy's own id and the upstream's id must coexist, not collide.
    const entry: RequestLogEntry = {
      timestamp: "2026-09-22T00:00:00.000Z",
      event: "request",
      modelId: "gpt-5-codex",
      keyId: "k-1",
      upstreamUrl: "https://api.example.com/v1/responses",
      stream: true,
      traceId: "proxy-side-id",
      upstreamRequestId: "upstream-side-id",
    };

    expect(entry.traceId).toBe("proxy-side-id");
    expect(entry.upstreamRequestId).toBe("upstream-side-id");
  });

  it("survives the JSONL serialisation writeLog performs", () => {
    const entry: RequestLogEntry = {
      timestamp: "2026-09-22T00:00:00.000Z",
      event: "request",
      modelId: "gpt-5-codex",
      keyId: "k-1",
      upstreamUrl: "https://api.example.com/v1/responses",
      stream: true,
      traceId: "018f-test-trace",
    };

    const round = JSON.parse(JSON.stringify(entry)) as RequestLogEntry;
    expect(round.traceId).toBe("018f-test-trace");
  });
});
