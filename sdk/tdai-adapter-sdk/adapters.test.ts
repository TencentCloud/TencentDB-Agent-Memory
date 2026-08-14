/**
 * Tests for the concrete platform adapters (Whale / Codex) built on the SDK.
 * They import the plugin modules, which resolve the SDK via their vendored
 * copies — so this also verifies `npm run build:adapters` output is loadable.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// @ts-expect-error — plugin modules are plain JS without type declarations.
import { adapter as whale } from "../../whale-memory-tdai/adapter.js";
// @ts-expect-error — plugin modules are plain JS without type declarations.
import { adapter as codex } from "../../codex-memory-tdai/adapter.js";

const tmp = mkdtempSync(join(tmpdir(), "tdai-adapter-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("whale adapter", () => {
  it("captures directly from last_assistant_text (no transcript read)", () => {
    // Whale's parse is synchronous — assert the plain return value.
    expect(
      whale.parseCapturePayload({
        prompt: "user words",
        last_assistant_text: "assistant words",
        session_id: "w1",
      }),
    ).toEqual({ userContent: "user words", assistantContent: "assistant words", sessionKey: "w1" });
  });

  it("emits Whale-style decision/additional_context recall output", () => {
    expect(JSON.parse(whale.formatRecallOutput("ctx", {}))).toEqual({
      decision: "pass",
      additional_context: "## Memory Context\nctx",
    });
  });
});

describe("codex adapter", () => {
  it("emits Codex-style hookSpecificOutput recall output", () => {
    expect(JSON.parse(codex.formatRecallOutput("ctx", {}))).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "ctx" },
    });
  });

  it("parses the latest user/assistant turn from transcript JSONL", async () => {
    const transcript = join(tmp, "transcript.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({ role: "user", content: "old question" }),
        JSON.stringify({ role: "assistant", content: "old answer" }),
        "not-json-line",
        JSON.stringify({ role: "user", content: "latest question" }),
        JSON.stringify({ role: "assistant", content: [{ type: "text" }] }), // non-string skipped
        JSON.stringify({ role: "assistant", content: "latest answer" }),
      ].join("\n"),
    );
    await expect(
      codex.parseCapturePayload({ session_id: "c1", transcript_path: transcript }),
    ).resolves.toEqual({
      userContent: "latest question",
      assistantContent: "latest answer",
      sessionKey: "c1",
    });
  });

  it("only scans the last 20 transcript lines", async () => {
    const transcript = join(tmp, "long.jsonl");
    const lines = [JSON.stringify({ role: "user", content: "too old" })];
    for (let i = 0; i < 20; i++) {
      lines.push(JSON.stringify({ role: "assistant", content: `a${i}` }));
    }
    writeFileSync(transcript, lines.join("\n"));
    await expect(
      codex.parseCapturePayload({ session_id: "c", transcript_path: transcript }),
    ).resolves.toEqual({ userContent: "", assistantContent: "a19", sessionKey: "c" });
  });

  it("returns null when the transcript is missing or absent from the payload", async () => {
    await expect(codex.parseCapturePayload({ session_id: "c" })).resolves.toBeNull();
    await expect(
      codex.parseCapturePayload({ session_id: "c", transcript_path: join(tmp, "nope.jsonl") }),
    ).resolves.toBeNull();
  });

  it("returns null for a transcript with no usable turn", async () => {
    const transcript = join(tmp, "empty.jsonl");
    writeFileSync(transcript, JSON.stringify({ role: "system", content: "meta" }));
    await expect(
      codex.parseCapturePayload({ session_id: "c", transcript_path: transcript }),
    ).resolves.toBeNull();
  });
});
