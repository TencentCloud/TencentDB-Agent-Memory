import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { MemoryTdaiConfig } from "../config.js";
import { performAutoCapture } from "../core/hooks/auto-capture.js";
import type { Logger } from "../core/types.js";
import {
  buildCaptureTurn,
  HISTORICAL_CAPTURE_STARTED_AT,
  MAX_CAPTURE_BATCH_SIZE,
  normalizeCaptureBatchRequest,
  normalizeCapturePayload,
} from "./capture-batch.js";

const testLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("capture batch request normalization", () => {
  it("keeps single /capture payloads timestamp-free when callers omit timestamps", () => {
    const capture = normalizeCapturePayload({
      user_content: "live question",
      assistant_content: "live answer",
      session_key: "live-session",
    });

    expect(capture.messages).toEqual([
      { role: "user", content: "live question" },
      { role: "assistant", content: "live answer" },
    ]);
  });

  it("normalizes multiple /capture payloads for historical live import", () => {
    const result = normalizeCaptureBatchRequest({
      captures: [
        {
          user_content: "hello",
          assistant_content: "hi",
          session_key: "session-a",
          session_id: "sid-a",
        },
        {
          user_content: "next",
          assistant_content: "done",
          session_key: "session-a",
          messages: [
            { role: "user", content: "next", timestamp: "2026-07-02T00:00:00.000Z" },
            { role: "assistant", content: "done" },
          ],
        },
      ],
      continue_on_error: true,
    }, 1_000);

    expect(result.source).toBe("captures");
    expect(result.continueOnError).toBe(true);
    expect(result.captures).toHaveLength(2);
    expect(result.captures[0]).toMatchObject({
      index: 0,
      startedAt: HISTORICAL_CAPTURE_STARTED_AT,
      capture: {
        user_content: "hello",
        assistant_content: "hi",
        session_key: "session-a",
        session_id: "sid-a",
      },
    });

    const firstMessages = result.captures[0]!.capture.messages as Array<{ timestamp: number }>;
    expect(firstMessages.map((message) => message.timestamp)).toEqual([1_000, 1_100]);

    const secondMessages = result.captures[1]!.capture.messages as Array<{ timestamp: number }>;
    expect(secondMessages[0]!.timestamp).toBe(Date.parse("2026-07-02T00:00:00.000Z"));
    expect(secondMessages[1]!.timestamp).toBe(1_200);
  });

  it("accepts seed-format data and converts each round to a live capture item", () => {
    const result = normalizeCaptureBatchRequest({
      data: {
        sessions: [
          {
            sessionKey: "historical-session",
            sessionId: "import-run-1",
            conversations: [
              [
                { role: "user", content: "What did we decide?", timestamp: "2024-01-01T00:00:00.000Z" },
                { role: "assistant", content: "Use the live gateway store.", timestamp: "2024-01-01T00:00:01.000Z" },
              ],
            ],
          },
        ],
      },
      strict_round_role: true,
    });

    expect(result.source).toBe("seed");
    expect(result.captures).toHaveLength(1);
    expect(result.captures[0]).toMatchObject({
      index: 0,
      startedAt: HISTORICAL_CAPTURE_STARTED_AT,
      sourceSessionIndex: 0,
      sourceRoundIndex: 0,
      capture: {
        user_content: "What did we decide?",
        assistant_content: "Use the live gateway store.",
        session_key: "historical-session",
        session_id: "import-run-1",
      },
    });

    const messages = result.captures[0]!.capture.messages as Array<{ timestamp: number }>;
    expect(messages.map((message) => message.timestamp)).toEqual([
      Date.parse("2024-01-01T00:00:00.000Z"),
      Date.parse("2024-01-01T00:00:01.000Z"),
    ]);
  });

  it("auto-fills missing timestamps for seed-format HTTP imports by default", () => {
    const result = normalizeCaptureBatchRequest({
      data: [
        {
          sessionKey: "seed-without-timestamps",
          conversations: [
            [
              { role: "user", content: "missing ts" },
              { role: "assistant", content: "filled" },
            ],
          ],
        },
      ],
    });

    const messages = result.captures[0]!.capture.messages as Array<{ timestamp: number }>;
    expect(messages).toHaveLength(2);
    expect(messages.every((message) => Number.isInteger(message.timestamp) && message.timestamp > 0)).toBe(true);
    expect(messages[1]!.timestamp).toBeGreaterThan(messages[0]!.timestamp);
  });

  it("builds historical CompletedTurn objects with the cold-start floor disabled", () => {
    const normalized = normalizeCaptureBatchRequest({
      captures: [
        {
          user_content: "old question",
          assistant_content: "old answer",
          session_key: "history",
          messages: [
            { role: "user", content: "old question", timestamp: 10 },
            { role: "assistant", content: "old answer", timestamp: 20 },
          ],
        },
      ],
    });

    const item = normalized.captures[0]!;
    const turn = buildCaptureTurn(item.capture, { startedAt: item.startedAt });
    expect(turn.startedAt).toBe(0);
    expect(turn.messages).toEqual(item.capture.messages);
  });

  it("lets historical timestamps pass through the real capture path", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "tdai-capture-batch-"));
    const messages = [
      { role: "user", content: "old question", timestamp: 10 },
      { role: "assistant", content: "old answer", timestamp: 20 },
    ];

    try {
      const liveColdStart = await performAutoCapture({
        messages,
        sessionKey: "cold-start",
        cfg: {} as MemoryTdaiConfig,
        pluginDataDir: path.join(tempDir, "live"),
        pluginStartTimestamp: Date.now(),
        logger: testLogger,
      });
      expect(liveColdStart.l0RecordedCount).toBe(0);

      const historicalImport = await performAutoCapture({
        messages,
        sessionKey: "historical-import",
        cfg: {} as MemoryTdaiConfig,
        pluginDataDir: path.join(tempDir, "import"),
        pluginStartTimestamp: HISTORICAL_CAPTURE_STARTED_AT,
        logger: testLogger,
      });
      expect(historicalImport.l0RecordedCount).toBe(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects seed-format data when timestamp filling is disabled and all timestamps are missing", () => {
    expect(() =>
      normalizeCaptureBatchRequest({
        data: [
          {
            sessionKey: "seed-without-timestamps",
            conversations: [
              [
                { role: "user", content: "missing ts" },
                { role: "assistant", content: "not fillable" },
              ],
            ],
          },
        ],
        auto_fill_timestamps: false,
      }),
    ).toThrow("requires timestamps unless auto_fill_timestamps is true");
  });

  it("rejects ambiguous requests that provide both seed data and capture items", () => {
    expect(() =>
      normalizeCaptureBatchRequest({
        data: { sessions: [] },
        captures: [
          {
            user_content: "hello",
            assistant_content: "hi",
            session_key: "session-a",
          },
        ],
      }),
    ).toThrow("provide either data or captures, not both");
  });

  it("rejects batches over the safety limit", () => {
    const captures = Array.from({ length: MAX_CAPTURE_BATCH_SIZE + 1 }, () => ({
      user_content: "hello",
      assistant_content: "hi",
      session_key: "session-a",
    }));

    expect(() => normalizeCaptureBatchRequest({ captures })).toThrow(
      `captures must contain at most ${MAX_CAPTURE_BATCH_SIZE} items`,
    );
  });

  it("rejects capture items missing required fields", () => {
    expect(() =>
      normalizeCaptureBatchRequest({
        captures: [
          {
            user_content: "hello",
            assistant_content: "hi",
          },
        ],
      }),
    ).toThrow("captures[0].session_key must be a non-empty string");
  });

  it("rejects malformed message timestamps instead of silently falling back to now", () => {
    expect(() =>
      normalizeCapturePayload({
        user_content: "hello",
        assistant_content: "hi",
        session_key: "session-a",
        messages: [
          { role: "user", content: "hello", timestamp: "yesterday-ish" },
          { role: "assistant", content: "hi" },
        ],
      }),
    ).toThrow("valid ISO 8601 string");
  });

  it("rejects seed rounds that cannot become completed capture turns", () => {
    expect(() =>
      normalizeCaptureBatchRequest({
        data: [
          {
            sessionKey: "partial",
            conversations: [
              [
                { role: "user", content: "only user", timestamp: 1 },
              ],
            ],
          },
        ],
      }),
    ).toThrow("must contain at least one user and one assistant message");
  });
});
