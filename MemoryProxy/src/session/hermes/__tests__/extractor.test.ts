import { describe, it, expect } from "vitest";
import { extractHermesAnswers, HERMES_BYPASS_TEXT } from "../extractor.js";

describe("extractHermesAnswers", () => {
  it("returns null for non-JSON content", () => {
    expect(extractHermesAnswers("plain text answer")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractHermesAnswers("")).toBeNull();
  });

  it("extracts single question user_response", () => {
    const content = JSON.stringify({
      question: "请选择 Team",
      choices_offered: ["Alpha (11112222)", "Beta (33334444)"],
      user_response: "Alpha (11112222)",
    });
    expect(extractHermesAnswers(content)).toBe("Alpha (11112222)");
  });

  it("returns bypass for headless error envelope", () => {
    const content = JSON.stringify({ error: "Clarify tool is not available in this execution context." });
    expect(extractHermesAnswers(content)).toBe(HERMES_BYPASS_TEXT);
  });

  it("returns bypass for timeout", () => {
    const content = JSON.stringify({
      question: "test",
      user_response: "The user did not provide a response within the time limit. Use your best judgement.",
    });
    expect(extractHermesAnswers(content)).toBe(HERMES_BYPASS_TEXT);
  });

  it("returns bypass for oneshot auto-answer", () => {
    const content = JSON.stringify({
      question: "test",
      user_response: "[oneshot mode: no user available. auto-answering.]",
    });
    expect(extractHermesAnswers(content)).toBe(HERMES_BYPASS_TEXT);
  });

  it("returns bypass for timed_out batch", () => {
    const content = JSON.stringify({
      responses: [{ question: "q1", user_response: "a1" }],
      timed_out: true,
    });
    expect(extractHermesAnswers(content)).toBe(HERMES_BYPASS_TEXT);
  });

  it("extracts batch responses joined with |", () => {
    const content = JSON.stringify({
      responses: [
        { question: "q1", user_response: "a1" },
        { question: "q2", user_response: "a2" },
      ],
    });
    expect(extractHermesAnswers(content)).toBe("a1 | a2");
  });

  it("returns empty string for valid envelope but no user_response", () => {
    const content = JSON.stringify({ question: "test", user_response: "" });
    expect(extractHermesAnswers(content)).toBe("");
  });

  it("handles multi_select user_response array", () => {
    const content = JSON.stringify({
      question: "test",
      user_response: ["opt1", "opt2"],
    });
    expect(extractHermesAnswers(content)).toBe("opt1 | opt2");
  });
});
