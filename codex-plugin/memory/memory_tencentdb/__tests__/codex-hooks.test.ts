import { Readable, Writable } from "node:stream";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { readHookInput, writeHookOutput } from "../hooks/io.js";
import { runRecallHook } from "../hooks/recall.js";
import { runCaptureHook } from "../hooks/capture.js";

describe("hook IO", () => {
  it("reads one JSON payload and writes one JSON response", async () => {
    let output = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });

    const input = await readHookInput(Readable.from(['{"session_id":"session-a"}']));
    await writeHookOutput({ continue: true }, stdout);

    expect(input).toEqual({ session_id: "session-a" });
    expect(JSON.parse(output)).toEqual({ continue: true });
  });
});

describe("runRecallHook", () => {
  it("caches the prompt, calls prefetch, and returns additional context", async () => {
    const writePrompt = vi.fn().mockResolvedValue(undefined);
    const prefetch = vi.fn().mockResolvedValue({ context: "The user's name is Wang Ke" });

    const output = await runRecallHook(
      { session_id: "session-a", prompt: "remember my name" },
      {
        writePrompt,
        createAdapter: () => ({ prefetch }),
      },
    );

    expect(writePrompt).toHaveBeenCalledWith("session-a", "remember my name");
    expect(prefetch).toHaveBeenCalledWith("remember my name");
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "The user's name is Wang Ke",
      },
    });
  });

  it("fails open with empty context when the Gateway is unavailable", async () => {
    const warn = vi.fn();
    const output = await runRecallHook(
      { session_id: "session-a", prompt: "hello" },
      {
        writePrompt: vi.fn().mockResolvedValue(undefined),
        createAdapter: () => ({ prefetch: vi.fn().mockRejectedValue(new Error("offline")) }),
        logger: { warn },
      },
    );

    expect(output.hookSpecificOutput?.additionalContext).toBe("");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("offline"));
  });
});

describe("runCaptureHook", () => {
  it("captures the cached prompt and deletes it after success", async () => {
    const captureTurn = vi.fn().mockResolvedValue({ l0_recorded: 1 });
    const deletePrompt = vi.fn().mockResolvedValue(undefined);

    const output = await runCaptureHook(
      { session_id: "session-a", last_assistant_message: "I will remember it" },
      {
        readPrompt: vi.fn().mockResolvedValue("remember my name"),
        deletePrompt,
        readTranscript: vi.fn(),
        createAdapter: () => ({ captureTurn }),
      },
    );

    expect(captureTurn).toHaveBeenCalledWith({
      userText: "remember my name",
      assistantText: "I will remember it",
    });
    expect(deletePrompt).toHaveBeenCalledWith("session-a");
    expect(output).toEqual({ continue: true });
  });

  it("retains the cached prompt when capture fails", async () => {
    const deletePrompt = vi.fn();
    const warn = vi.fn();

    await runCaptureHook(
      { session_id: "session-a", last_assistant_message: "answer" },
      {
        readPrompt: vi.fn().mockResolvedValue("question"),
        deletePrompt,
        readTranscript: vi.fn(),
        createAdapter: () => ({ captureTurn: vi.fn().mockRejectedValue(new Error("offline")) }),
        logger: { warn },
      },
    );

    expect(deletePrompt).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("offline"));
  });

  it("fails open when local cache state cannot be read", async () => {
    const warn = vi.fn();

    await expect(runCaptureHook(
      { session_id: "session-a", last_assistant_message: "answer" },
      {
        readPrompt: vi.fn().mockRejectedValue(new Error("cache denied")),
        deletePrompt: vi.fn(),
        readTranscript: vi.fn(),
        createAdapter: vi.fn(),
        logger: { warn },
      },
    )).resolves.toEqual({ continue: true });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cache denied"));
  });

  it("falls back to the latest transcript turn when the cache is missing", async () => {
    const captureTurn = vi.fn().mockResolvedValue({ l0_recorded: 1 });

    await runCaptureHook(
      { session_id: "session-a", transcript_path: "transcript.jsonl" },
      {
        readPrompt: vi.fn().mockResolvedValue(null),
        deletePrompt: vi.fn().mockResolvedValue(undefined),
        readTranscript: vi.fn().mockResolvedValue({
          userText: "fallback question",
          assistantText: "fallback answer",
        }),
        createAdapter: () => ({ captureTurn }),
      },
    );

    expect(captureTurn).toHaveBeenCalledWith({
      userText: "fallback question",
      assistantText: "fallback answer",
    });
  });

  it("skips recursive Stop hooks and incomplete turns", async () => {
    const createAdapter = vi.fn();
    const deps = {
      readPrompt: vi.fn().mockResolvedValue(null),
      deletePrompt: vi.fn(),
      readTranscript: vi.fn().mockResolvedValue(null),
      createAdapter,
    };

    await expect(runCaptureHook({ session_id: "session-a", stop_hook_active: true }, deps))
      .resolves.toEqual({ continue: true });
    await expect(runCaptureHook({ session_id: "session-a" }, deps))
      .resolves.toEqual({ continue: true });
    expect(createAdapter).not.toHaveBeenCalled();
  });
});

describe("Codex plugin structure", () => {
  it("discovers command hooks without declaring a private MCP server", async () => {
    const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const manifest = JSON.parse(
      await readFile(path.join(pluginDir, ".codex-plugin", "plugin.json"), "utf8"),
    ) as Record<string, unknown>;
    const hookConfig = JSON.parse(
      await readFile(path.join(pluginDir, "hooks", "hooks.json"), "utf8"),
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const marketplace = JSON.parse(
      await readFile(
        path.resolve(pluginDir, "..", "..", ".agents", "plugins", "marketplace.json"),
        "utf8",
      ),
    ) as { plugins: Array<{ name: string; source: { path: string } }> };

    expect(manifest.name).toBe("tencentdb-memory");
    expect(manifest).not.toHaveProperty("mcpServers");
    expect(manifest.hooks).toBe("./hooks/hooks.json");
    expect(marketplace.plugins).toContainEqual(expect.objectContaining({
      name: "tencentdb-memory",
      source: expect.objectContaining({ path: "./memory/memory_tencentdb" }),
    }));
    expect(hookConfig.hooks).toHaveProperty("UserPromptSubmit");
    expect(hookConfig.hooks).toHaveProperty("Stop");

    const recallCommand = hookConfig.hooks.UserPromptSubmit[0].hooks[0].command;
    const captureCommand = hookConfig.hooks.Stop[0].hooks[0].command;
    expect(recallCommand).toContain("hooks/recall.ts");
    expect(captureCommand).toContain("hooks/capture.ts");
    expect(recallCommand).toContain("TDAI_MEMORY_ROOT");
    expect(captureCommand).toContain("TDAI_MEMORY_ROOT");
    expect(recallCommand).not.toContain("PLUGIN_ROOT");
    expect(captureCommand).not.toContain("PLUGIN_ROOT");
    await expect(access(path.join(pluginDir, "hooks", "recall.ts"))).resolves.toBeUndefined();
    await expect(access(path.join(pluginDir, "hooks", "capture.ts"))).resolves.toBeUndefined();
  });
});
