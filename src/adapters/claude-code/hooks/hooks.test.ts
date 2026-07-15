/**
 * Hooks 契约测试 —— recall / capture / session-end 三个钩子的 main()。
 *
 * 测试策略（对齐 Step 2.1 验收「钩子契约测试」）：
 *   - 喂样例 stdin JSON（字符串注入，绕过 process.stdin）
 *   - 注入 mock TdaiClient（断言 Gateway 调用）
 *   - 捕获 stdout（断言 additionalContext 输出 JSON 合法）
 *   - 断言永不抛出、退出码语义（main 不抛 = 退出 0）
 *
 * extractLastTurn（capture 的 transcript 解析）单独测，用 mock fsImpl 注入文件内容。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TdaiClient } from "../../../sdk/client";
import type { RecallResponse, CaptureResponse } from "../../../gateway/types";
import { main as recallMain } from "./recall";
import { main as captureMain, extractLastTurn } from "./capture";
import { main as sessionEndMain } from "./session-end";

// ============================
// mock client 工厂
// ============================

interface MockClient {
  recall: ReturnType<typeof vi.fn>;
  capture: ReturnType<typeof vi.fn>;
  searchMemories: ReturnType<typeof vi.fn>;
  searchConversations: ReturnType<typeof vi.fn>;
  endSession: ReturnType<typeof vi.fn>;
  health: ReturnType<typeof vi.fn>;
}

function makeMockClient(): MockClient & TdaiClient {
  return {
    recall: vi.fn(),
    capture: vi.fn(),
    searchMemories: vi.fn(),
    searchConversations: vi.fn(),
    endSession: vi.fn(),
    health: vi.fn(),
  } as unknown as MockClient & TdaiClient;
}

// ============================
// stdout 捕获
// ============================

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 取 stdout 写入的合并文本。 */
function getStdout(): string {
  const calls = stdoutSpy.mock.calls as unknown as string[][];
  return calls.map((c) => c[0]).join("");
}

// ============================
// recall 钩子
// ============================

describe("recall hook (UserPromptSubmit)", () => {
  it("有 prompt + recall 返回 context → 输出 additionalContext JSON", async () => {
    const client = makeMockClient();
    const resp: RecallResponse = { context: "用户偏好 TypeScript" };
    client.recall.mockResolvedValue(resp);

    await recallMain(
      JSON.stringify({ session_id: "s1", prompt: "我喜欢什么语言", cwd: "/tmp" }),
      client,
    );

    expect(client.recall).toHaveBeenCalledOnce();
    const args = client.recall.mock.calls[0]!;
    expect(args[0]).toBe("我喜欢什么语言");
    // sessionKey 取自 session_id
    expect(args[1]).toBe("s1");

    const out = getStdout();
    expect(out).toContain("hookSpecificOutput");
    expect(out).toContain("UserPromptSubmit");
    expect(out).toContain("<relevant-memories>");
    expect(out).toContain("用户偏好 TypeScript");
  });

  it("recall 返回空 context → 不输出 additionalContext", async () => {
    const client = makeMockClient();
    client.recall.mockResolvedValue({ context: "" });

    await recallMain(
      JSON.stringify({ session_id: "s1", prompt: "你好", cwd: "/tmp" }),
      client,
    );

    expect(client.recall).toHaveBeenCalledOnce();
    expect(getStdout()).toBe("");
  });

  it("stdin 为空 → 不调 client，不输出", async () => {
    const client = makeMockClient();
    await recallMain("", client);
    expect(client.recall).not.toHaveBeenCalled();
    expect(getStdout()).toBe("");
  });

  it("stdin 非法 JSON → 不调 client，不输出，不抛", async () => {
    const client = makeMockClient();
    await expect(recallMain("not json{", client)).resolves.toBeUndefined();
    expect(client.recall).not.toHaveBeenCalled();
    expect(getStdout()).toBe("");
  });

  it("无 prompt 字段 → 不调 client", async () => {
    const client = makeMockClient();
    await recallMain(JSON.stringify({ session_id: "s1", cwd: "/tmp" }), client);
    expect(client.recall).not.toHaveBeenCalled();
  });

  it("recall 抛异常 → 钩子不抛（binding 吞掉），不输出", async () => {
    const client = makeMockClient();
    client.recall.mockRejectedValue(new Error("gateway down"));
    await expect(
      recallMain(JSON.stringify({ session_id: "s1", prompt: "hi", cwd: "/tmp" }), client),
    ).resolves.toBeUndefined();
    expect(getStdout()).toBe("");
  });

  it("无 session_id → sessionKey 回退 cwd::日期", async () => {
    const client = makeMockClient();
    client.recall.mockResolvedValue({ context: "ctx" });
    await recallMain(JSON.stringify({ prompt: "hi", cwd: "D:\\proj" }), client);
    const sessionKey = client.recall.mock.calls[0]![1] as string;
    // 反斜杠归一为 /，去尾斜杠，含 ::日期
    expect(sessionKey).toMatch(/^D:\/proj::\d{4}-\d{2}-\d{2}$/);
  });
});

// ============================
// capture 钩子
// ============================

describe("capture hook (Stop)", () => {
  it("有 transcript_path + user/assistant → 调 client.capture", async () => {
    const client = makeMockClient();
    const ack: CaptureResponse = { l0_recorded: 2, scheduler_notified: false };
    client.capture.mockResolvedValue(ack);

    const transcript = [
      JSON.stringify({ type: "user", message: { role: "user", content: "什么是闭包" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "闭包是函数及其词法环境的组合" }],
        },
      }),
    ].join("\n");
    const fsImpl = () => transcript;

    await captureMain(
      JSON.stringify({ session_id: "s1", transcript_path: "/tmp/t.jsonl", cwd: "/tmp" }),
      client,
      fsImpl,
    );

    expect(client.capture).toHaveBeenCalledOnce();
    const args = client.capture.mock.calls[0]!;
    expect(args[0]).toBe("什么是闭包");
    expect(args[1]).toContain("闭包是函数");
    expect(args[2]).toBe("s1"); // sessionKey
  });

  it("content 为 string 与 array 两种形态都能解析", async () => {
    const client = makeMockClient();
    client.capture.mockResolvedValue({ l0_recorded: 1, scheduler_notified: false });

    const transcript = [
      JSON.stringify({ type: "user", message: { role: "user", content: "字符串内容" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "数组" }, { type: "text", text: "内容" }],
        },
      }),
    ].join("\n");

    await captureMain(
      JSON.stringify({ session_id: "s1", transcript_path: "/tmp/t.jsonl" }),
      client,
      () => transcript,
    );

    const args = client.capture.mock.calls[0]!;
    expect(args[0]).toBe("字符串内容");
    expect(args[1]).toBe("数组内容");
  });

  it("transcript 只有 user 无 assistant → 不调 capture", async () => {
    const client = makeMockClient();
    const transcript = JSON.stringify({
      type: "user",
      message: { role: "user", content: "只有用户" },
    });
    await captureMain(
      JSON.stringify({ session_id: "s1", transcript_path: "/tmp/t.jsonl" }),
      client,
      () => transcript,
    );
    expect(client.capture).not.toHaveBeenCalled();
  });

  it("无 transcript_path → 不调 capture", async () => {
    const client = makeMockClient();
    await captureMain(JSON.stringify({ session_id: "s1", cwd: "/tmp" }), client);
    expect(client.capture).not.toHaveBeenCalled();
  });

  it("transcript 文件不可读 → 不调 capture，不抛", async () => {
    const client = makeMockClient();
    const fsImpl = () => {
      throw new Error("ENOENT");
    };
    await expect(
      captureMain(
        JSON.stringify({ session_id: "s1", transcript_path: "/tmp/missing.jsonl" }),
        client,
        fsImpl,
      ),
    ).resolves.toBeUndefined();
    expect(client.capture).not.toHaveBeenCalled();
  });

  it("capture 抛异常 → 钩子不抛（binding 吞掉）", async () => {
    const client = makeMockClient();
    client.capture.mockRejectedValue(new Error("gateway 500"));
    const transcript = [
      JSON.stringify({ type: "user", message: { role: "user", content: "u" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "a" } }),
    ].join("\n");
    await expect(
      captureMain(
        JSON.stringify({ session_id: "s1", transcript_path: "/tmp/t.jsonl" }),
        client,
        () => transcript,
      ),
    ).resolves.toBeUndefined();
  });

  it("空 stdin → 不调 capture，不抛", async () => {
    const client = makeMockClient();
    await expect(captureMain("", client)).resolves.toBeUndefined();
    expect(client.capture).not.toHaveBeenCalled();
  });
});

// ============================
// extractLastTurn 单测
// ============================

describe("extractLastTurn", () => {
  it("多轮对话 → 返回最后一条 user + 最后一条 assistant", () => {
    const transcript = [
      JSON.stringify({ type: "user", message: { role: "user", content: "第一问" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "第一答" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "第二问" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "第二答" } }),
    ].join("\n");
    const turn = extractLastTurn("/tmp/t.jsonl", () => transcript);
    expect(turn).toEqual({ userText: "第二问", assistantText: "第二答" });
  });

  it("含非法 JSON 行 → 跳过该行继续解析", () => {
    const transcript = [
      "{bad json",
      JSON.stringify({ type: "user", message: { role: "user", content: "有效问" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "有效答" } }),
    ].join("\n");
    const turn = extractLastTurn("/tmp/t.jsonl", () => transcript);
    expect(turn).toEqual({ userText: "有效问", assistantText: "有效答" });
  });

  it("空文件 → null", () => {
    expect(extractLastTurn("/tmp/t.jsonl", () => "")).toBeNull();
  });

  it("文件不可读 → null", () => {
    expect(extractLastTurn("/tmp/t.jsonl", () => { throw new Error("ENOENT"); })).toBeNull();
  });
});

// ============================
// session-end 钩子
// ============================

describe("session-end hook (SessionEnd)", () => {
  it("有 session_id → 调 client.endSession", async () => {
    const client = makeMockClient();
    client.endSession.mockResolvedValue(undefined);

    await sessionEndMain(
      JSON.stringify({ session_id: "s1", transcript_path: "/tmp/t.jsonl", cwd: "/tmp" }),
      client,
    );

    expect(client.endSession).toHaveBeenCalledOnce();
    const args = client.endSession.mock.calls[0]!;
    expect(args[0]).toBe("s1"); // sessionKey
  });

  it("endSession 抛异常 → 钩子不抛（binding 吞掉）", async () => {
    const client = makeMockClient();
    client.endSession.mockRejectedValue(new Error("gateway down"));
    await expect(
      sessionEndMain(JSON.stringify({ session_id: "s1", cwd: "/tmp" }), client),
    ).resolves.toBeUndefined();
  });

  it("空 stdin → 不调 client，不抛", async () => {
    const client = makeMockClient();
    await expect(sessionEndMain("", client)).resolves.toBeUndefined();
    expect(client.endSession).not.toHaveBeenCalled();
  });

  it("非法 JSON stdin → 不调 client，不抛", async () => {
    const client = makeMockClient();
    await expect(sessionEndMain("{{{", client)).resolves.toBeUndefined();
    expect(client.endSession).not.toHaveBeenCalled();
  });
});
