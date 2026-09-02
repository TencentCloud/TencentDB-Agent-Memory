import { describe, expect, it } from "vitest";
import {
  extractCompletedTurnsFromQwenTranscript,
  getLatestCompletedQwenTurn,
} from "./transcript-parser.js";

describe("Qwen Code transcript parser", () => {
  it("extracts completed user and assistant turns from JSONL", () => {
    const raw = [
      JSON.stringify({ id: "u1", message: { role: "user", content: "Please remember Vitest." } }),
      JSON.stringify({ id: "a1", message: { role: "assistant", content: [{ text: "Got it." }] } }),
      JSON.stringify({ id: "tool", message: { role: "tool", content: "ignored" } }),
      JSON.stringify({ id: "u2", message: { role: "user", content: "What did I ask?" } }),
      JSON.stringify({ id: "a2", message: { role: "assistant", content: "You asked about Vitest." } }),
    ].join("\n");

    expect(extractCompletedTurnsFromQwenTranscript(raw)).toEqual([
      {
        userText: "Please remember Vitest.",
        assistantText: "Got it.",
        sourceIds: ["u1", "a1"],
      },
      {
        userText: "What did I ask?",
        assistantText: "You asked about Vitest.",
        sourceIds: ["u2", "a2"],
      },
    ]);
  });

  it("ignores malformed trailing JSONL records", () => {
    const raw = [
      JSON.stringify({ id: "u1", role: "user", content: "Hello" }),
      JSON.stringify({ id: "a1", role: "assistant", content: "Hi" }),
      '{"message":',
    ].join("\n");

    expect(getLatestCompletedQwenTurn(raw)?.assistantText).toBe("Hi");
  });

  it("does not return incomplete turns", () => {
    const raw = JSON.stringify({ id: "u1", role: "user", content: "No assistant yet" });
    expect(extractCompletedTurnsFromQwenTranscript(raw)).toEqual([]);
  });
});

