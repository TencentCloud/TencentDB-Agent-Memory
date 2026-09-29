/** Cursor 插件到 v3 SDK 的本地自动化链路；不替代真实 Cursor + MemoryCore E2E。 */
import { afterEach, describe, expect, it } from "vitest";
import {
  PERSONA_MARKER,
  SCENE_PATH,
  createTempSandbox,
  drainWorker,
  listPendingFiles,
  readPendingBodies,
  runSessionStart,
  runStopCapture,
  startFakeMemoryV3,
  writeClosedTranscript,
  type HookRunLog,
} from "./helpers.js";

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()?.();
});

describe("Cursor v3 memory-effect", () => {
  it("sessionStart 通过真实 SDK 并发召回 L3/L2", async () => {
    const fake = await startFakeMemoryV3();
    disposers.push(fake.close);
    const sandbox = await createTempSandbox(fake.url);
    disposers.push(sandbox.dispose);

    const response = await runSessionStart(sandbox, "conv-recall");
    const context = String(response.additional_context ?? "");

    expect(context).toContain(PERSONA_MARKER);
    expect(context).toContain(SCENE_PATH);
    expect(context).toContain("tdai_memory_search");
    expect(fake.requests.map((request) => request.path).sort()).toEqual([
      "/v3/core/read",
      "/v3/scenario/ls",
    ]);
  });

  it("sessionStart 到 stop 再到 worker 完成 v3 capture", async () => {
    const fake = await startFakeMemoryV3();
    disposers.push(fake.close);
    const sandbox = await createTempSandbox(fake.url);
    disposers.push(sandbox.dispose);
    const conversationId = `conv-${sandbox.token.toLowerCase()}`;
    const log: HookRunLog[] = [];

    await runSessionStart(sandbox, conversationId, log);
    const transcriptPath = await writeClosedTranscript({
      projectsRoot: sandbox.projectsRoot,
      conversationId,
      userText: sandbox.rememberPrompt,
      assistantText: `已确认：${sandbox.token}`,
    });
    const spawned = { count: 0 };
    await runStopCapture(sandbox, {
      conversationId,
      generationId: "gen-1",
      transcriptPath,
    }, log, spawned);

    expect(spawned.count).toBe(1);
    expect(await listPendingFiles(sandbox.cursorRoot)).toHaveLength(1);
    expect((await readPendingBodies(sandbox.cursorRoot)).join("\n")).toContain(sandbox.token);

    await drainWorker(sandbox, log);

    const capture = fake.requests.find((request) => request.path === "/v3/conversation/add");
    expect(capture?.headers.authorization).toBe("Bearer test-api-key");
    expect(capture?.headers["x-tdai-service-id"]).toBe("service-1");
    expect(capture?.body).toMatchObject({
      team_id: "team-1",
      agent_id: "agent-1",
      user_id: "user-1",
      task_id: "task-1",
      session_id: `cursor:${conversationId}`,
      messages: [
        { role: "user", content: sandbox.rememberPrompt },
        { role: "assistant", content: `已确认：${sandbox.token}` },
      ],
    });
    expect(await listPendingFiles(sandbox.cursorRoot)).toEqual([]);
    expect(log.some((entry) => entry.event === "capture_acked")).toBe(true);
  });

  it("未分类 stop 不写 pending", async () => {
    const sandbox = await createTempSandbox("http://127.0.0.1:1");
    disposers.push(sandbox.dispose);
    const transcriptPath = await writeClosedTranscript({
      projectsRoot: sandbox.projectsRoot,
      conversationId: "unclassified",
      userText: sandbox.rememberPrompt,
      assistantText: "ok",
    });

    await runStopCapture(sandbox, {
      conversationId: "unclassified",
      generationId: "gen-1",
      transcriptPath,
    });

    expect(await listPendingFiles(sandbox.cursorRoot)).toEqual([]);
  });

  it("网络失败保留 pending，服务恢复后重试成功", async () => {
    const sandbox = await createTempSandbox("http://127.0.0.1:1");
    disposers.push(sandbox.dispose);
    const conversationId = "conv-retry";
    await runSessionStart(sandbox, conversationId);
    const transcriptPath = await writeClosedTranscript({
      projectsRoot: sandbox.projectsRoot,
      conversationId,
      userText: sandbox.rememberPrompt,
      assistantText: "ok",
    });
    await runStopCapture(sandbox, {
      conversationId,
      generationId: "gen-retry",
      transcriptPath,
    });

    await drainWorker(sandbox);
    expect(await listPendingFiles(sandbox.cursorRoot)).toHaveLength(1);

    const fake = await startFakeMemoryV3();
    disposers.push(fake.close);
    sandbox.config.gatewayUrl = fake.url;
    await drainWorker(sandbox);

    expect(await listPendingFiles(sandbox.cursorRoot)).toEqual([]);
    expect(fake.requests.some((request) => request.path === "/v3/conversation/add")).toBe(true);
  });
});
