import { describe, expect, it, vi } from "vitest";
import { handleHook, type HookDependencies } from "../src/hooks.js";

function dependencies(overrides: Partial<HookDependencies> = {}): HookDependencies {
  return {
    rootDir: "/root",
    transcriptsRoot: "/home/test/.cursor/projects",
    appendTranscript: vi.fn().mockResolvedValue("/pending/key.jsonl"),
    spawnWorker: vi.fn(),
    buildContext: vi.fn().mockResolvedValue("context"),
    markTopLevel: vi.fn(),
    isTopLevel: vi.fn().mockResolvedValue(true),
    clearSession: vi.fn(),
    log: vi.fn(),
    now: () => 1,
    ...overrides,
  };
}

describe("Cursor Hook v3 生命周期", () => {
  // sessionStart 是唯一允许前台网络召回的 Hook, 且只处理顶层会话.
  it("顶层 sessionStart 写 marker 并注入 context", async () => {
    const deps = dependencies();

    const result = await handleHook({
      hook_event_name: "sessionStart",
      conversation_id: "c1",
      is_background_agent: false,
    }, deps);

    expect(result).toEqual({ additional_context: "context" });
    expect(deps.markTopLevel).toHaveBeenCalledWith("/root", "c1");
    expect(deps.buildContext).toHaveBeenCalledOnce();
    expect(deps.spawnWorker).not.toHaveBeenCalled();
  });

  // Background sessionStart 只清 marker, 不召回也不投递.
  it("跳过 background sessionStart", async () => {
    const deps = dependencies();

    const result = await handleHook({
      hook_event_name: "sessionStart",
      conversation_id: "bg",
      is_background_agent: true,
    }, deps);

    expect(result).toEqual({});
    expect(deps.clearSession).toHaveBeenCalledWith("/root", "bg");
    expect(deps.buildContext).not.toHaveBeenCalled();
    expect(deps.spawnWorker).not.toHaveBeenCalled();
  });

  // sessionEnd 只能无参数唤醒 worker 并清 marker, 不再传 sessionEndKey.
  it("sessionEnd 无参数唤醒 worker", async () => {
    const deps = dependencies();

    await handleHook({
      hook_event_name: "sessionEnd",
      session_id: "session-1",
    }, deps);

    expect(deps.spawnWorker).toHaveBeenCalledWith();
    expect(deps.clearSession).toHaveBeenCalledWith("/root", "session-1");
    expect(deps.buildContext).not.toHaveBeenCalled();
  });

  // stop 只写本地 pending 后无参数唤醒 worker, 前台不构造网络 client.
  it("stop 追加完整 transcript 并唤醒 worker", async () => {
    const deps = dependencies();

    await handleHook({
      hook_event_name: "stop",
      conversation_id: "c1",
      generation_id: "g1",
      status: "completed",
      transcript_path: "/transcript.jsonl",
    }, deps);

    expect(deps.appendTranscript).toHaveBeenCalledWith(
      "/root",
      "/home/test/.cursor/projects",
      "/transcript.jsonl",
      "c1",
      "g1",
      "completed",
      1,
    );
    expect(deps.spawnWorker).toHaveBeenCalledWith();
    expect(deps.buildContext).not.toHaveBeenCalled();
  });

  // 未分类或 transcript 失败也必须 fail-open 唤醒其它 pending.
  it.each(["unclassified", "transcript-error"])("stop %s 时仍唤醒 worker", async (mode) => {
    const deps = dependencies({
      isTopLevel: vi.fn().mockResolvedValue(mode !== "unclassified"),
      appendTranscript: mode === "transcript-error"
        ? vi.fn().mockRejectedValue(new Error("invalid transcript"))
        : vi.fn(),
    });

    const result = await handleHook({
      hook_event_name: "stop",
      conversation_id: "c1",
      generation_id: "g1",
      transcript_path: "/transcript.jsonl",
    }, deps);

    expect(result).toEqual({});
    expect(deps.spawnWorker).toHaveBeenCalledWith();
  });

  // sessionStart 内部错误不得阻断 Cursor.
  it("sessionStart 错误时 fail-open", async () => {
    const deps = dependencies({
      buildContext: vi.fn().mockRejectedValue(new Error("unavailable")),
    });

    const result = await handleHook({
      hook_event_name: "sessionStart",
      conversation_id: "c1",
      is_background_agent: false,
    }, deps);

    expect(result).toEqual({});
    expect(deps.log).toHaveBeenCalledWith("hook_error", expect.objectContaining({
      event: "sessionStart",
    }));
  });
});
