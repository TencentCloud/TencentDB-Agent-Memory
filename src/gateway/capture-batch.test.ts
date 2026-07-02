import { describe, expect, it } from "vitest";
import {
  MAX_CAPTURE_BATCH_SIZE,
  normalizeCaptureBatchRequest,
  normalizeCapturePayload,
} from "./capture-batch.js";

describe("capture batch request normalization", () => {
  it("normalizes multiple /capture payloads and preserves optional messages", () => {
    const result = normalizeCaptureBatchRequest({
      captures: [
        {
          user_content: "hello",
          assistant_content: "hi",
          session_key: "session-a",
          session_id: "sid-a",
          messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi" },
          ],
        },
        {
          user_content: "next",
          assistant_content: "done",
          session_key: "session-a",
        },
      ],
      continue_on_error: true,
    });

    expect(result.continueOnError).toBe(true);
    expect(result.captures).toHaveLength(2);
    expect(result.captures[0]).toMatchObject({
      user_content: "hello",
      assistant_content: "hi",
      session_key: "session-a",
      session_id: "sid-a",
    });
    expect(result.captures[0].messages).toHaveLength(2);
  });

  it("accepts items as a compatibility alias", () => {
    const result = normalizeCaptureBatchRequest({
      items: [
        {
          user_content: "hello",
          assistant_content: "hi",
          session_key: "session-a",
        },
      ],
    });

    expect(result.continueOnError).toBe(false);
    expect(result.captures).toHaveLength(1);
  });

  it("rejects an empty batch", () => {
    expect(() => normalizeCaptureBatchRequest({ captures: [] })).toThrow(
      "captures must be a non-empty array",
    );
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

  it("rejects non-array messages", () => {
    expect(() =>
      normalizeCapturePayload({
        user_content: "hello",
        assistant_content: "hi",
        session_key: "session-a",
        messages: "not an array",
      }),
    ).toThrow("capture.messages must be an array when provided");
  });
});
