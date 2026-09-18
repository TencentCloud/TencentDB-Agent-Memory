/**
 * Regression tests for session-init form artifact stripping.
 *
 * Context: the proxy synthesizes an `AskUserQuestion` tool_use (id prefixed
 * `toolu_cc_session_init_`) and the client echoes it back with a `tool_result`.
 * Upstream providers in extended-thinking mode (DeepSeek) validate that every
 * assistant tool_use carries a real server-signed `thinking` block, so these
 * synthetic, signature-less blocks are rejected with 400. `stripSessionInitArtifacts`
 * removes them before forwarding.
 */
import { describe, it, expect } from "vitest";
import { stripSessionInitArtifacts } from "../form.js";

const INIT_TOOL_ID = "toolu_cc_session_init_1786532541855";

describe("stripSessionInitArtifacts", () => {
  it("drops a synthetic assistant form message", () => {
    const out = stripSessionInitArtifacts([
      { role: "user", content: "你好" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: INIT_TOOL_ID, name: "AskUserQuestion", input: {} }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: INIT_TOOL_ID, content: "是" }] },
    ]);
    expect(out).toEqual([{ role: "user", content: "你好" }]);
  });

  it("preserves real (non-init) tool_use messages", () => {
    const msg = {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_01abc", name: "Read", input: {} }],
    };
    expect(stripSessionInitArtifacts([msg])).toEqual([msg]);
  });

  it("keeps real text blocks when stripping an init tool_result", () => {
    const out = stripSessionInitArtifacts([
      {
        role: "user",
        content: [
          { type: "text", text: "real question" },
          { type: "tool_result", tool_use_id: INIT_TOOL_ID, content: "是" },
        ],
      },
    ]);
    expect(out).toEqual([{ role: "user", content: [{ type: "text", text: "real question" }] }]);
  });

  it("preserves real thinking + tool_use pairs", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "thinking text", signature: "sig_abc" },
        { type: "tool_use", id: "toolu_real_1", name: "Bash", input: {} },
      ],
    };
    expect(stripSessionInitArtifacts([msg])).toEqual([msg]);
  });

  it("returns identity for untouched input", () => {
    const msgs = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
    const out = stripSessionInitArtifacts(msgs);
    expect(out).toEqual(msgs);
    // elements are the original references — nothing rebuilt, no mutation
    expect(out[0]).toBe(msgs[0]);
    expect(out[1]).toBe(msgs[1]);
  });

  it("strips init form from the middle of a conversation", () => {
    const out = stripSessionInitArtifacts([
      { role: "user", content: "你好" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: INIT_TOOL_ID, name: "AskUserQuestion", input: {} }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: INIT_TOOL_ID, content: "否" }] },
      { role: "assistant", content: "好的" },
      { role: "user", content: "继续" },
    ]);
    expect(out).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "好的" },
      { role: "user", content: "继续" },
    ]);
  });
});
