/**
 * isToolLoopContinuation — codex /v1/responses tool-loop continuation
 * detection (issue #1245 fix).
 *
 * codex re-sends the full conversation history in input[] on every round, so
 * the detector must be positional (last function_call_output vs last user
 * message), not "any function_call_output exists" — otherwise every user
 * turn after the first tool loop would be misread as a continuation and its
 * user message never recorded to L0.
 */
import { describe, expect, it } from "vitest";
import { isToolLoopContinuation } from "../codexHandler.js";

const user = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});
const functionCall = (id: string) => ({
  type: "function_call",
  call_id: id,
  name: "tool",
  arguments: "{}",
});
const functionOutput = (id: string) => ({
  type: "function_call_output",
  call_id: id,
  output: "ok",
});
const assistant = (text: string) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});

describe("isToolLoopContinuation", () => {
  it("first round of a turn: only the user message → not a continuation", () => {
    expect(isToolLoopContinuation([user("hi")])).toBe(false);
  });

  it("tool-loop round: newest input is a function_call_output → continuation", () => {
    expect(isToolLoopContinuation([user("hi"), functionCall("c1"), functionOutput("c1")])).toBe(true);
  });

  it("stays a continuation across multi-round tool loops", () => {
    expect(
      isToolLoopContinuation([
        user("hi"),
        functionCall("c1"),
        functionOutput("c1"),
        functionCall("c2"),
        functionOutput("c2"),
      ]),
    ).toBe(true);
  });

  it("new user turn after a finished tool loop → NOT a continuation (regression: full history is re-sent)", () => {
    expect(
      isToolLoopContinuation([
        user("first task"),
        functionCall("c1"),
        functionOutput("c1"),
        assistant("done"),
        user("second task"),
      ]),
    ).toBe(false);
  });

  it("second tool loop of a later turn: user message precedes its outputs → continuation", () => {
    expect(
      isToolLoopContinuation([
        user("first task"),
        functionCall("c1"),
        functionOutput("c1"),
        assistant("done"),
        user("second task"),
        functionCall("c2"),
        functionOutput("c2"),
      ]),
    ).toBe(true);
  });

  it("non-array / empty input → not a continuation", () => {
    expect(isToolLoopContinuation(undefined)).toBe(false);
    expect(isToolLoopContinuation("not-an-array")).toBe(false);
    expect(isToolLoopContinuation([])).toBe(false);
  });

  it("items without recognizable type/role are ignored", () => {
    expect(isToolLoopContinuation([user("hi"), { foo: "bar" }, null])).toBe(false);
  });
});
