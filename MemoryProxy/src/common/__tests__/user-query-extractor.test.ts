import { describe, expect, it } from "vitest";
import { extractUserQueryText, extractUserQueryTextFromBlocks } from "../user-query-extractor.js";

const harnessTags = [
  "task-notification",
  "local-command-caveat", "local-command-stdout", "local-command-stderr",
  "command-name", "command-message", "command-args",
  "bash-input", "bash-stdout", "bash-stderr",
];

const continuationSummary = "This session is being continued from a previous conversation that ran out of context. " +
  "The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Earlier work.";

const interruptMarkers = [
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
];

describe("extractUserQueryText: Claude Code harness messages", () => {
  it.each(harnessTags)("discards a standalone <%s> payload", (tag) => {
    expect(extractUserQueryText(`<${tag}>Generated content\nsecond line</${tag}>`)).toBe("");
  });

  it.each(harnessTags)("keeps user text beside <%s> with attributes", (tag) => {
    const raw = `<${tag} source="cli">Generated content</${tag}>\n请检查这次修改。`;
    expect(extractUserQueryText(raw)).toBe("请检查这次修改。");
  });

  it("strips a complete local slash-command echo and its output", () => {
    const raw = [
      "<local-command-caveat>Do not respond to these local messages.</local-command-caveat>",
      "<command-name>/compact</command-name>",
      "<command-message>compact</command-message>",
      "<command-args>keep recent changes</command-args>",
      "<local-command-stdout>Compacted conversation.</local-command-stdout>",
      "<local-command-stderr></local-command-stderr>",
    ].join("\n");
    expect(extractUserQueryText(raw)).toBe("");
  });

  it("keeps a boundary between user instructions separated by a notification", () => {
    expect(extractUserQueryText(
      "Check the API.<task-notification>Build passed.</task-notification>Then run tests.",
    )).toBe("Check the API.\nThen run tests.");
  });

  it("handles repeated notifications and case-insensitive wrapper names", () => {
    expect(extractUserQueryText(
      "<TASK-NOTIFICATION>First task.</TASK-NOTIFICATION>\n" +
      "<task-notification>Second task.</task-notification>\nWhat changed?",
    )).toBe("What changed?");
  });

  it("does not promote a user_query embedded in a task result to human input", () => {
    expect(extractUserQueryText(
      "<task-notification><summary><user_query>Generated query</user_query></summary></task-notification>",
    )).toBe("");
  });

  it("extracts only explicit queries outside task notifications", () => {
    const raw = "<task-notification><user_query>Generated query</user_query></task-notification>" +
      "<user_query>Review the patch.</user_query><user_query>Keep the public API.</user_query>";
    expect(extractUserQueryText(raw)).toBe("Review the patch.\n\nKeep the public API.");
  });

  it("preserves harness-looking examples inside an explicit user_query", () => {
    const query = "Explain <task-notification>Build passed.</task-notification> and <bash-input>pwd</bash-input>.";
    expect(extractUserQueryText(`<user_query>${query}</user_query>`)).toBe(query);
  });

  it.each(interruptMarkers)("discards the interrupt marker %s", (marker) => {
    expect(extractUserQueryText(` \n${marker}`)).toBe("");
    expect(extractUserQueryText(`<system-reminder>Environment context</system-reminder>\n${marker}`)).toBe("");
  });

  // CC merges consecutive user messages before sending, so harness blocks and the
  // next typed prompt arrive in one message.
  it.each(interruptMarkers)("keeps the prompt merged after the interrupt marker %s", (marker) => {
    expect(extractUserQueryTextFromBlocks([
      marker, "<system-reminder>Todo list changed</system-reminder>", "Use approach B instead.",
    ])).toBe("Use approach B instead.");
  });

  it("discards a continuation summary block, even when it quotes user_query blocks", () => {
    expect(extractUserQueryTextFromBlocks([continuationSummary])).toBe("");
    expect(extractUserQueryTextFromBlocks(["<system-reminder>Context</system-reminder>", continuationSummary])).toBe("");
    expect(extractUserQueryTextFromBlocks([
      `${continuationSummary}\n<user_query>Historical question</user_query>`,
    ])).toBe("");
  });

  it("keeps the first prompt merged after a continuation summary", () => {
    expect(extractUserQueryTextFromBlocks([
      continuationSummary, "<system-reminder>Read a file</system-reminder>", "Now add tests for the parser.",
    ])).toBe("Now add tests for the parser.");
  });

  it.each([
    "Explain the message: This session is being continued from a previous conversation.",
    "Why does [Request interrupted by user] appear?",
    "[Request interrupted by username validation]",
    "<task-notification-example>Keep this custom XML.</task-notification-example>",
  ])("preserves ordinary text mentioning harness markers: %s", (text) => {
    expect(extractUserQueryText(text)).toBe(text);
    expect(extractUserQueryTextFromBlocks([text])).toBe(text);
  });
});

describe("extractUserQueryText: existing input formats", () => {
  it("preserves CodeBuddy user_query precedence over session-init context", () => {
    const raw = "<user_info>Windows</user_info><question_answer>会话初始化</question_answer>" +
      "<user_query>Fix the parser.\n\nKeep <system-reminder>example</system-reminder> literal.</user_query>";
    expect(extractUserQueryText(raw)).toBe(
      "Fix the parser.\n\nKeep <system-reminder>example</system-reminder> literal.",
    );
  });

  it("still strips existing wrappers while preserving the user instruction", () => {
    const raw = "<system-reminder>Context</system-reminder><persisted-output>Tool output</persisted-output>\n" +
      "<tool_result>Generated text</tool_result>\nReview the changes.";
    expect(extractUserQueryText(raw)).toBe("Review the changes.");
  });

  it("applies whole-message internal rules to the raw message only", () => {
    const raw = "<additional_data>current_time: now</additional_data>\n" +
      "Your questions have been answered: \"Which team?\"=\"A\".\n<user_query>Deploy it</user_query>";
    expect(extractUserQueryText(raw)).toBe("Deploy it");
  });

  it.each([
    "",
    "Current runtime context.\nGenerated DSH snapshot.",
    "[SUGGESTION MODE: generate a suggestion]\n<user_query>Generated query</user_query>",
    "Your questions have been answered: \"Which team?\"",
  ])("still discards existing internal input: %s", (text) => {
    expect(extractUserQueryText(text)).toBe("");
  });

  it("preserves normal multiline user input", () => {
    const text = "# Request\n\nFix the bug.\n\n---\n\n1. Keep the API stable.\n2. Add a test.";
    expect(extractUserQueryText(text)).toBe(text);
  });
});
