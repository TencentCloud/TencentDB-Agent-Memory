// Regression tests for #1509 (unstripped CC harness wrappers leaked into L0/L1)
// and #1510 (catastrophic backtracking in the frontmatter-stripping regex).
//
// The #1510 benchmark block inlines the OLD regex side by side: on ~100
// key:value lines without a closing fence the old pattern takes seconds
// (super-linear backtracking) while the line scan stays flat.
import { describe, expect, it } from "vitest";
import { extractUserQueryText } from "../common/user-query-extractor.js";

describe("#1509 CC harness wrappers are stripped, user text kept", () => {
  it("task-notification wrapper containing a completion notice", () => {
    const raw = "<task-notification>Background command exited 0</task-notification>\n帮我看看结果";
    expect(extractUserQueryText(raw)).toBe("帮我看看结果");
  });

  it("entire message is a task-notification → empty (nothing user-typed)", () => {
    const raw = "<task-notification>Background command exited 0</task-notification>";
    expect(extractUserQueryText(raw)).toBe("");
  });

  it("local-command caveat/stdout/stderr wrappers", () => {
    const raw = [
      "<local-command-caveat>caveat text</local-command-caveat>",
      "真正的提问",
      "<local-command-stdout>some output</local-command-stdout>",
      "<local-command-stderr>some err</local-command-stderr>",
    ].join("\n");
    expect(extractUserQueryText(raw)).toContain("真正的提问");
    expect(extractUserQueryText(raw)).not.toContain("caveat");
    expect(extractUserQueryText(raw)).not.toContain("some output");
  });

  it("slash-command echoes (command-name/message/args)", () => {
    const raw = "<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>src</command-args>\n请审查这段代码";
    const out = extractUserQueryText(raw);
    expect(out).toContain("请审查这段代码");
    expect(out).not.toContain("command-name");
    expect(out).not.toContain("review</command-message");
  });

  it("bash-input/stdout/stderr wrappers", () => {
    const raw = "<bash-input>ls -la</bash-input>\n<bash-stdout>file-a</bash-stdout>\n<bash-stderr></bash-stderr>\n这个列表对吗";
    const out = extractUserQueryText(raw);
    expect(out).toContain("这个列表对吗");
    expect(out).not.toContain("file-a");
  });

  it("compact continuation summary → empty", () => {
    const raw = "This session is being continued from a previous conversation that ran out of context. Here is a summary...";
    expect(extractUserQueryText(raw)).toBe("");
  });

  it("[Request interrupted by user] alone → empty", () => {
    expect(extractUserQueryText("[Request interrupted by user]")).toBe("");
  });
});

describe("#1510 frontmatter stripping: linear scan replaces catastrophic regex", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `key_${i}: some value ${i}`).join("\n");
  const pathological = `---\n${lines(120)}\n`; // many key:value lines, NO closing fence

  it("pathological input processed fast (no backtracking blowup); unclosed fence conservatively kept", () => {
    const t0 = performance.now();
    const out = extractUserQueryText(pathological);
    const ms = performance.now() - t0;
    expect(ms, `line scan took ${ms}ms on 120 key:value lines`).toBeLessThan(200);
    // an unclosed `---` may be a markdown horizontal rule — the conservative
    // (and correct) semantics is to keep the content untouched
    expect(out).toContain("some value 119");
  });

  it("OLD regex backtracks super-linearly (documents the bug, kept small enough to terminate)", () => {
    // NOTE: this benchmark was first tried at 40 lines and did NOT terminate
    // within 5 minutes — that run is itself the red demonstration of #1510.
    // Kept at 12/16 lines here so CI stays fast while still showing the blow-up.
    const OLD = /(?:^|\n)---\s*\n(?:[a-z_][a-z0-9_]*:\s*.*\n)*?(?:name|description|metadata|node_type|originSessionId):[\s\S]*?\n---\s*(?:\n|$)/gi;
    const timed = (n: number) => {
      const input = `---\n${lines(n)}\n`;
      const t0 = performance.now();
      input.replace(OLD, "\n");
      return performance.now() - t0;
    };
    const small = timed(12);
    const bigger = timed(16);
    // super-linear growth: +4 lines multiplies the cost
    expect(bigger, `12 lines=${small.toFixed(1)}ms vs 16 lines=${bigger.toFixed(1)}ms`).toBeGreaterThan(small * 2);
  });

  it("legitimate frontmatter is still stripped (semantics preserved)", () => {
    const raw = "---\nname: some-memory\ndescription: a memory file\nmetadata: {}\n---\n用户真的输入的话";
    const out = extractUserQueryText(raw);
    expect(out).toContain("用户真的输入的话");
    expect(out).not.toContain("description");
  });

  it("markdown horizontal rules are not mistaken for frontmatter", () => {
    const raw = "上文\n---\n下文";
    expect(extractUserQueryText(raw)).toContain("上文");
    expect(extractUserQueryText(raw)).toContain("下文");
  });
});
