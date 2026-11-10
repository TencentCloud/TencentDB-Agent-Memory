import { describe, expect, it } from "vitest";
import { parseL15Response } from "./l15-parser.js";
import { parseL15Response as parseServer } from "../../../offload_server/parsers/l15-parser.js";

describe("local L1.5 judgment boolean compatibility", () => {
  it.each([
    ["false", false],
    ["FALSE", false],
    ["0", false],
    ["", false],
    ["true", true],
    [false, false],
    [true, true],
  ])("interprets %s consistently with the server parser", (value, expected) => {
    const raw = JSON.stringify({ taskCompleted: value, isContinuation: value, isLongTask: value });
    const judgment = { taskCompleted: expected, isContinuation: expected, isLongTask: expected };
    expect(parseServer(raw)).toMatchObject(judgment);
    expect(parseL15Response(raw)).toMatchObject(judgment);
  });

  it("does not complete or continue a task for explicit false strings", () => {
    const raw = JSON.stringify({ taskCompleted: "false", isContinuation: "false", isLongTask: "0", newTaskLabel: "new task" });
    expect(parseL15Response(raw)).toMatchObject({ taskCompleted: false, isContinuation: false, isLongTask: false, newTaskLabel: "new task" });
  });

  it("retains unavailable-response handling and optional string fields", () => {
    expect(parseL15Response("not JSON")).toBeNull();
    expect(parseL15Response('{"taskCompleted":null,"isContinuation":null,"isLongTask":null}')).toBeNull();
    expect(parseL15Response('{"taskCompleted":false,"isContinuation":true,"isLongTask":true,"continuationMmdFile":"001-task.mmd"}')).toMatchObject({ taskCompleted: false, isContinuation: true, isLongTask: true, continuationMmdFile: "001-task.mmd" });
  });
});
