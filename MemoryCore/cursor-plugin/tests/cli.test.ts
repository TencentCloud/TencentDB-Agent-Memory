import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, type CursorCliRuntime } from "../src/cli.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

function runtime(payload = "{}"): CursorCliRuntime {
  const rootDir = path.join(
    os.tmpdir(),
    `cursor-cli-${process.pid}-${Math.random().toString(16).slice(2)}`,
  );
  tempRoots.push(rootDir);
  return {
    readStdin: vi.fn().mockResolvedValue(payload),
    writeStdout: vi.fn(),
    writeStderr: vi.fn(),
    spawnDetached: vi.fn(),
    runMcp: vi.fn().mockResolvedValue(undefined),
    runWorker: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
    uninstall: vi.fn().mockResolvedValue(undefined),
    appendTranscript: vi.fn().mockResolvedValue("/pending/key.jsonl"),
    buildContext: vi.fn().mockResolvedValue("context"),
    log: vi.fn(),
    env: { MEMORY_TENCENTDB_CURSOR_ROOT: rootDir },
    home: "/home/test",
    cwd: "/project",
    executablePath: "/bin/memory-tencentdb-cursor",
    now: () => 1,
  };
}

describe("memory-tencentdb-cursor CLI", () => {
  // 生产命令面只保留 Hook、worker、MCP 和安装卸载.
  it("帮助中不包含 spike 或 session-end 参数", async () => {
    const io = runtime();

    expect(await main(["--help"], io)).toBe(0);

    const output = vi.mocked(io.writeStdout).mock.calls.join("\n");
    for (const command of ["hook", "worker", "mcp", "install", "uninstall"]) {
      expect(output).toContain(command);
    }
    expect(output).not.toContain("spike");
    expect(output).not.toContain("session-end");
  });

  // stop 只唤醒无参数 detached worker.
  it("hook stop 无参数唤醒 worker", async () => {
    const io = runtime(JSON.stringify({
      hook_event_name: "stop",
      conversation_id: "c1",
      generation_id: "g1",
      status: "completed",
      transcript_path: "/transcript.jsonl",
    }));

    expect(await main(["hook", "tencentdb-memory-cursor-v1"], io)).toBe(0);

    expect(io.spawnDetached).toHaveBeenCalledWith(["worker"]);
    expect(io.writeStdout).toHaveBeenCalledWith("{}\n");
  });

  // sessionStart 的 v3 context 构造失败也必须由 Hook fail-open.
  it("hook sessionStart 注入 context", async () => {
    const io = runtime(JSON.stringify({
      hook_event_name: "sessionStart",
      conversation_id: "c1",
      is_background_agent: false,
    }));

    expect(await main(["hook"], io)).toBe(0);

    expect(io.buildContext).toHaveBeenCalledOnce();
    expect(io.writeStdout).toHaveBeenCalledWith('{"additional_context":"context"}\n');
  });

  // 非法 Hook 输入不得泄漏原始 payload, 且 stdout 始终为合法 JSON.
  it("非法 Hook JSON fail-open", async () => {
    const io = runtime("sensitive-prompt-is-not-json");

    expect(await main(["hook"], io)).toBe(0);

    expect(io.writeStdout).toHaveBeenCalledWith("{}\n");
    expect(JSON.stringify(vi.mocked(io.log).mock.calls)).not.toContain("sensitive-prompt");
    expect(io.log).toHaveBeenCalledWith("hook_input_error", {
      reason: "invalid_json",
    });
  });

  // 已删除的 sessionEndKey 参数不得被静默接受.
  it("worker 拒绝旧 --session-end 参数", async () => {
    const io = runtime();

    expect(await main(["worker", "--session-end", "cursor:c1"], io)).toBe(1);

    expect(io.runWorker).not.toHaveBeenCalled();
    expect(io.writeStderr).toHaveBeenCalledWith("worker does not accept arguments\n");
  });

  // spike 仅是验证资产, 生产 CLI 不再路由该命令.
  it("拒绝 spike 命令", async () => {
    const io = runtime();

    expect(await main(["spike"], io)).toBe(1);

    expect(io.writeStderr).toHaveBeenCalledWith("Unknown command: spike\n");
  });
});
