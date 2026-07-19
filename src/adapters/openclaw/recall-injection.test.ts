import { describe, expect, it } from "vitest";

import {
  shapeOpenClawRecallResult,
  stripInjectedRecallFromMessage,
} from "./recall-injection.js";

describe("shapeOpenClawRecallResult", () => {
  it("keeps legacy prependContext in prepend mode", () => {
    const result = shapeOpenClawRecallResult(
      {
        appendSystemContext: "<user-persona>stable</user-persona>",
        prependContext: "<relevant-memories>dynamic</relevant-memories>",
      },
      "prepend",
    );

    expect(result).toEqual({
      appendSystemContext: "<user-persona>stable</user-persona>",
      prependContext: "<relevant-memories>dynamic</relevant-memories>",
    });
  });

  it("moves dynamic recall to appendContext in append mode", () => {
    const result = shapeOpenClawRecallResult(
      {
        appendSystemContext: "<user-persona>stable</user-persona>",
        prependContext: "<relevant-memories>dynamic</relevant-memories>",
        recallStrategy: "hybrid",
      },
      "append",
    );

    expect(result).toEqual({
      appendSystemContext: "<user-persona>stable</user-persona>",
      appendContext: "<relevant-memories>dynamic</relevant-memories>",
      recallStrategy: "hybrid",
    });
  });

  it("returns undefined when input is undefined", () => {
    expect(shapeOpenClawRecallResult(undefined, "append")).toBeUndefined();
  });

  it("returns result unchanged when no prependContext", () => {
    const result = shapeOpenClawRecallResult(
      { appendSystemContext: "stable" },
      "append",
    );

    expect(result).toEqual({ appendSystemContext: "stable" });
  });
});

describe("stripInjectedRecallFromMessage", () => {
  it("strips relevant memories from persisted user strings by default", () => {
    const result = stripInjectedRecallFromMessage(
      {
        role: "user",
        content: "<relevant-memories>\nold dynamic recall\n</relevant-memories>\n\nWhat changed?",
      },
      false,
    );

    expect(result?.message.content).toBe("What changed?");
    expect(result?.strippedChars).toBeGreaterThan(0);
  });

  it("preserves injected recall when showInjected is enabled", () => {
    const message = {
      role: "user",
      content: "<relevant-memories>debug me</relevant-memories>\nQuestion",
    };

    expect(stripInjectedRecallFromMessage(message, true)).toBeUndefined();
  });

  it("skips non-user messages", () => {
    expect(stripInjectedRecallFromMessage(
      { role: "assistant", content: "<relevant-memories>x</relevant-memories>" },
      false,
    )).toBeUndefined();
  });

  it("strips only text parts in multipart user content", () => {
    const imagePart = { type: "image_url", image_url: { url: "https://example.com/a.png" } };
    const result = stripInjectedRecallFromMessage(
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<relevant-memories>dynamic</relevant-memories>\nLook at this image",
          },
          imagePart,
        ],
      },
      false,
    );

    expect(result?.message.content).toEqual([
      { type: "text", text: "Look at this image" },
      imagePart,
    ]);
  });

  it("returns undefined for clean content", () => {
    expect(stripInjectedRecallFromMessage(
      { role: "user", content: "Plain text" },
      false,
    )).toBeUndefined();
  });
});
