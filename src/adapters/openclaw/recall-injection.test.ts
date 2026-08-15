import { describe, expect, it } from "vitest";

import {
  resolveRecallInjectionMode,
  shapeOpenClawRecallResult,
  stripInjectedRecallFromMessage,
} from "./recall-injection.js";

describe("resolveRecallInjectionMode", () => {
  it("keeps prepend mode independent of host capability", () => {
    expect(resolveRecallInjectionMode("prepend", undefined)).toEqual({
      requested: "prepend",
      effective: "prepend",
      hostVersion: null,
    });
  });

  it("uses appendContext on supported hosts", () => {
    expect(resolveRecallInjectionMode("append", "2026.4.27-beta.1")).toEqual({
      requested: "append",
      effective: "append",
      hostVersion: [2026, 4, 27],
    });
  });

  it("falls back safely for old or unknown hosts", () => {
    expect(resolveRecallInjectionMode("append", "2026.4.26").fallbackReason)
      .toBe("append-context-unsupported");
    expect(resolveRecallInjectionMode("append", undefined).fallbackReason)
      .toBe("unknown-host-version");
  });
});

describe("shapeOpenClawRecallResult", () => {
  const coreResult = {
    prependSystemContext: "<user-persona>stable</user-persona>",
    prependContext: "<relevant-memories>dynamic</relevant-memories>",
    recallStrategy: "hybrid",
  } as const;

  it("preserves the legacy hook shape in prepend mode", () => {
    expect(shapeOpenClawRecallResult(coreResult, "prepend")).toEqual(coreResult);
  });

  it("moves only dynamic L1 recall in append mode", () => {
    expect(shapeOpenClawRecallResult(coreResult, "append")).toEqual({
      prependSystemContext: "<user-persona>stable</user-persona>",
      appendContext: "<relevant-memories>dynamic</relevant-memories>",
      recallStrategy: "hybrid",
    });
  });
});

describe("stripInjectedRecallFromMessage", () => {
  it("strips injected recall from persisted string content by default", () => {
    const result = stripInjectedRecallFromMessage({
      role: "user",
      content: "<relevant-memories>stale recall</relevant-memories>\n\nCurrent question",
    }, false);

    expect(result?.message.content).toBe("Current question");
    expect(result?.removedChars).toBeGreaterThan(0);
  });

  it("preserves injected recall only when explicitly requested", () => {
    const message = {
      role: "user",
      content: "<relevant-memories>debug</relevant-memories>\nQuestion",
    };

    expect(stripInjectedRecallFromMessage(message, true)).toBeUndefined();
  });

  it("cleans text parts without changing non-text content", () => {
    const image = { type: "image_url", image_url: { url: "https://example.com/a.png" } };
    const result = stripInjectedRecallFromMessage({
      role: "user",
      content: [
        {
          type: "text",
          text: "<relevant-memories>dynamic</relevant-memories>\nInspect this image",
        },
        image,
      ],
    }, false);

    expect(result?.message.content).toEqual([
      { type: "text", text: "Inspect this image" },
      image,
    ]);
    expect(result?.contentType).toBe("parts");
  });

  it("prevents injected-history growth across multiple turns", () => {
    const recall = `<relevant-memories>${"memory ".repeat(100)}</relevant-memories>\n`;
    const storedWithCleanup: string[] = [];
    const storedWithVisibility: string[] = [];

    for (let turn = 1; turn <= 5; turn += 1) {
      const content = `${recall}Question ${turn}`;
      const cleaned = stripInjectedRecallFromMessage({ role: "user", content }, false);
      storedWithCleanup.push(String(cleaned?.message.content));
      storedWithVisibility.push(content);
    }

    const cleanedChars = storedWithCleanup.join("\n").length;
    const visibleChars = storedWithVisibility.join("\n").length;
    expect(storedWithCleanup.every((text) => !text.includes("<relevant-memories>"))).toBe(true);
    expect(visibleChars - cleanedChars).toBeGreaterThan(recall.length * 4);
  });
});
