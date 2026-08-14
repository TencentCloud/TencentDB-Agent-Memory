import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { handleSessionEnd } from "./session-end.js";

describe("handleSessionEnd", () => {
  it("seeds parsed transcript conversations and flushes the session", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tdai-claude-session-end-"));
    const transcript = path.join(dir, "transcript.jsonl");
    const calls: Array<{ name: string; body: unknown }> = [];

    try {
      writeFileSync(transcript, [
        JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "hi" } }),
      ].join("\n"));

      await handleSessionEnd(
        {
          hook_event_name: "SessionEnd",
          session_id: "s1",
          cwd: "C:/tmp/project",
          transcript_path: transcript,
          reason: "clear",
        },
        {
          client: {
            seed: async (body) => {
              calls.push({ name: "seed", body });
              return {
                sessions_processed: 1,
                rounds_processed: 1,
                messages_processed: 2,
                l0_recorded: 2,
                duration_ms: 1,
                output_dir: "out",
              };
            },
            sessionEnd: async (body) => {
              calls.push({ name: "sessionEnd", body });
              return { flushed: true };
            },
          },
        },
      );

      expect(calls.map((call) => call.name)).toEqual(["seed", "sessionEnd"]);
      expect(calls[0].body).toMatchObject({
        data: {
          sessions: [{
            sessionId: "s1",
            conversations: [[
              { role: "user", content: "hello" },
              { role: "assistant", content: "hi" },
            ]],
          }],
        },
        strict_round_role: false,
        auto_fill_timestamps: true,
      });
      expect(calls[1].body).toMatchObject({ session_key: expect.stringMatching(/^agent:claude-code-/) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still flushes when transcript is missing", async () => {
    const calls: string[] = [];

    await handleSessionEnd(
      {
        hook_event_name: "SessionEnd",
        session_id: "s1",
        cwd: "C:/tmp/project",
        transcript_path: "C:/does/not/exist.jsonl",
      },
      {
        client: {
          seed: async () => {
            calls.push("seed");
            throw new Error("should not seed");
          },
          sessionEnd: async () => {
            calls.push("sessionEnd");
            return { flushed: true };
          },
        },
      },
    );

    expect(calls).toEqual(["sessionEnd"]);
  });
});

