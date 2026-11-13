import { describe, expect, it } from "vitest";
import { parseMemCommand } from "../mem-command/parser.js";

const clients = ["codebuddy", "workbuddy", "dsh", "opencode", "pi", "hermes"];
const text = (value: string) => ({ type: "text", text: value });
const user = (content: unknown) => ({ role: "user", content });

describe.each(clients)("%s mem command compatibility", (client) => {
  it.each([
    "mem:help",
    [text("mem:help")],
  ].map((content) => ({ content })))("recognizes a current command in string or text-block content: $content", ({ content }) => {
    expect(parseMemCommand({ messages: [user(content)] }, client)).toEqual({
      command: "help", args: "", rawMessage: "mem:help",
    });
  });

  it("preserves arguments and normalizes command case", () => {
    expect(parseMemCommand({ messages: [user(" MEM:create-skill 数据库迁移 ")] }, client))
      .toEqual({ command: "create-skill", args: "数据库迁移", rawMessage: "MEM:create-skill 数据库迁移" });
  });

  it.each(["Please explain mem:help", "mem:help and explain this", "ordinary question"])(
    "does not intercept ordinary user text: %s", (content) => {
      expect(parseMemCommand({ messages: [user(content)] }, client)).toBeNull();
    },
  );

  it.each([
    { role: "assistant", content: "done" },
    { role: "tool", content: "tool output", tool_call_id: "call-1" },
    user("a new question"),
  ])("does not replay a command from an older turn: %j", (last) => {
    expect(parseMemCommand({ messages: [user("mem:sync"), last] }, client)).toBeNull();
  });

  it("keeps explicit first-message recovery for session initialization", () => {
    const body = { messages: [user("mem:help"), user("form answer")] };
    expect(parseMemCommand(body, client)).toBeNull();
    expect(parseMemCommand(body, client, { checkFirst: true })?.command).toBe("help");
  });
});

describe.each(["codebuddy", "workbuddy", "opencode"])("%s context wrappers", (client) => {
  it.each([
    "<additional_data>current_time: today</additional_data>\n<user_query>mem:help</user_query>",
    [text("<additional_data>current_time: today</additional_data>"), text("<user_query>mem:help</user_query>")],
    [text("mem:help"), text("<system-reminder>workspace instructions</system-reminder>")],
  ].map((content) => ({ content })))("extracts the command through supported context wrappers: $content", ({ content }) => {
    expect(parseMemCommand({ messages: [user(content)] }, client))
      .toEqual({ command: "help", args: "", rawMessage: "mem:help" });
  });

  it("does not execute a command embedded only in context", () => {
    expect(parseMemCommand({ messages: [user([
      text("<system-reminder>mem:sync</system-reminder>"), text("ordinary question"),
    ])] }, client)).toBeNull();
  });
});
