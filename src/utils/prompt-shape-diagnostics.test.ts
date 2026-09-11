import { describe, expect, it } from "vitest";
import {
  captureMemoryPromptShape,
  compareMemoryPromptShapes,
  formatMemoryPromptShapeDiagnostic,
} from "./prompt-shape-diagnostics.js";

describe("prompt-shape diagnostics", () => {
  it("captures stable segment hashes without exposing source text in formatted output", () => {
    const secretMemory = "secret preference: likes jasmine tea";
    const shape = captureMemoryPromptShape({
      appendSystemContext: "<user-persona>stable persona</user-persona>",
      messages: [{ role: "user", content: "hello" }],
      prependContext: `<relevant-memories>${secretMemory}</relevant-memories>`,
      appendContext: "<relevant-memories>late memory</relevant-memories>",
      currentUserPrompt: "what should I drink?",
    });

    const formatted = formatMemoryPromptShapeDiagnostic(
      shape,
      compareMemoryPromptShapes(undefined, shape),
    );

    expect(formatted).toContain("appendSystemContext=");
    expect(formatted).toContain("prependContext=");
    expect(formatted).toContain("appendContext=");
    expect(formatted).not.toContain(secretMemory);
  });

  it("compares append, history, prepend, late context, and current prompt independently", () => {
    const previous = captureMemoryPromptShape({
      appendSystemContext: "stable persona and scene",
      messages: [{ role: "user", content: "same history" }],
      prependContext: "<relevant-memories>memory A</relevant-memories>",
      appendContext: "<relevant-memories>same late memory</relevant-memories>",
      currentUserPrompt: "same prompt",
    });
    const current = captureMemoryPromptShape({
      appendSystemContext: "stable persona and scene",
      messages: [{ role: "user", content: "same history" }],
      prependContext: "<relevant-memories>memory B</relevant-memories>",
      appendContext: "<relevant-memories>same late memory</relevant-memories>",
      currentUserPrompt: "same prompt",
    });

    const delta = compareMemoryPromptShapes(previous, current);

    expect(delta.firstSample).toBe(false);
    expect(delta.changedSegments).toEqual(["prependContext"]);
    expect(delta.unchangedSegments).toContain("appendSystemContext");
    expect(delta.unchangedSegments).toContain("history");
    expect(delta.unchangedSegments).toContain("appendContext");
    expect(delta.unchangedSegments).toContain("currentUserPrompt");
  });

  it("detects appendContext changes independently from stable prefix segments", () => {
    const previous = captureMemoryPromptShape({
      appendSystemContext: "stable persona and scene",
      messages: [{ role: "user", content: "same history" }],
      currentUserPrompt: "same prompt",
      appendContext: "<relevant-memories>memory A</relevant-memories>",
    });
    const current = captureMemoryPromptShape({
      appendSystemContext: "stable persona and scene",
      messages: [{ role: "user", content: "same history" }],
      currentUserPrompt: "same prompt",
      appendContext: "<relevant-memories>memory B</relevant-memories>",
    });

    const delta = compareMemoryPromptShapes(previous, current);

    expect(delta.changedSegments).toEqual(["appendContext"]);
    expect(delta.unchangedSegments).toContain("appendSystemContext");
    expect(delta.unchangedSegments).toContain("history");
    expect(delta.unchangedSegments).toContain("currentUserPrompt");
  });

  it("detects showInjected-style relevant memory accumulation in history", () => {
    const persistedInjectedPrompt =
      "<relevant-memories>persisted turn-one memory</relevant-memories>\nturn one";

    const shape = captureMemoryPromptShape({
      messages: [{ role: "user", content: persistedInjectedPrompt }],
      currentUserPrompt: "turn two",
    });

    expect(shape.relevantMemoriesInHistory.count).toBe(1);
    expect(shape.relevantMemoriesInHistory.totalChars).toBeGreaterThan(0);
  });

  it("replays baseline growth for clean history versus showInjected history", () => {
    const prompts = ["turn one", "turn two", "turn three"];
    const injectedBlocks = ["memory A", "memory B", "memory C"].map(
      (memory) => `<relevant-memories>${memory}</relevant-memories>`,
    );
    const stableAppend = "<user-persona>stable persona</user-persona>";

    const cleanHistory: unknown[] = [];
    const cleanShapes = prompts.map((prompt, index) => {
      const shape = captureMemoryPromptShape({
        appendSystemContext: stableAppend,
        messages: cleanHistory,
        prependContext: injectedBlocks[index],
        currentUserPrompt: prompt,
      });
      cleanHistory.push({ role: "user", content: prompt });
      return shape;
    });

    const injectedHistory: unknown[] = [];
    const showInjectedShapes = prompts.map((prompt, index) => {
      const shape = captureMemoryPromptShape({
        appendSystemContext: stableAppend,
        messages: injectedHistory,
        prependContext: injectedBlocks[index],
        currentUserPrompt: prompt,
      });
      injectedHistory.push({ role: "user", content: `${injectedBlocks[index]}\n${prompt}` });
      return shape;
    });

    expect(cleanShapes.map((shape) => shape.relevantMemoriesInHistory.count)).toEqual([0, 0, 0]);
    expect(showInjectedShapes.map((shape) => shape.relevantMemoriesInHistory.count)).toEqual([0, 1, 2]);

    const cleanDelta = compareMemoryPromptShapes(cleanShapes[1], cleanShapes[2]);
    const showInjectedDelta = compareMemoryPromptShapes(showInjectedShapes[1], showInjectedShapes[2]);

    expect(cleanDelta.changedSegments).not.toContain("appendSystemContext");
    expect(showInjectedDelta.changedSegments).not.toContain("appendSystemContext");
    expect(showInjectedShapes[2].relevantMemoriesInHistory.totalChars).toBeGreaterThan(
      cleanShapes[2].relevantMemoriesInHistory.totalChars,
    );
  });

  it("ignores non-prompt-visible message metadata when hashing history", () => {
    const first = captureMemoryPromptShape({
      messages: [{ id: "a", ts: 1, role: "user", content: "visible prompt" }],
    });
    const second = captureMemoryPromptShape({
      messages: [{ id: "b", ts: 2, role: "user", content: "visible prompt" }],
    });

    expect(first.history.sha256).toBe(second.history.sha256);
  });
});
