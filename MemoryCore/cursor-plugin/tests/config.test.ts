import { describe, expect, it } from "vitest";
import { createMemoryClient } from "../src/client.js";
import { resolveCursorConfig } from "../src/config.js";

describe("Cursor v3 配置", () => {
  // Adapter 配置必须完整映射 v3 isolation, 且 recall 使用独立短预算.
  it("解析 Gateway 和严格隔离配置", () => {
    const config = resolveCursorConfig({
      MEMORY_TENCENTDB_CURSOR_ROOT: "/cursor",
      MEMORY_TENCENTDB_GATEWAY_URL: "https://memory.example.com",
      MEMORY_TENCENTDB_GATEWAY_API_KEY: "secret",
      MEMORY_TENCENTDB_SERVICE_ID: "service-1",
      MEMORY_TENCENTDB_TEAM_ID: "team-1",
      MEMORY_TENCENTDB_AGENT_ID: "agent-1",
      MEMORY_TENCENTDB_USER_ID: "user-1",
      MEMORY_TENCENTDB_TASK_ID: "task-1",
      MEMORY_TENCENTDB_CURSOR_CAPTURE_TIMEOUT_MS: "70000",
      MEMORY_TENCENTDB_CURSOR_RECALL_TIMEOUT_MS: "1500",
      MEMORY_TENCENTDB_CURSOR_TRANSCRIPTS_ROOT: "/cursor-projects",
    }, "/home/test", "/bin/cursor-memory");

    expect(config).toEqual({
      rootDir: "/cursor",
      gatewayUrl: "https://memory.example.com",
      gatewayApiKey: "secret",
      serviceId: "service-1",
      teamId: "team-1",
      agentId: "agent-1",
      userId: "user-1",
      taskId: "task-1",
      captureTimeoutMs: 70_000,
      recallTimeoutMs: 1_500,
      executablePath: "/bin/cursor-memory",
      transcriptsRoot: "/cursor-projects",
    });
  });

  // 兼容 server_team 已使用的 TDAI_MEMORY 环境变量, 但不静默生成隔离 ID.
  it("支持 server_team 环境变量并保留缺失值", () => {
    const config = resolveCursorConfig({
      TDAI_MEMORY_ENDPOINT: "http://127.0.0.1:8420",
      TDAI_MEMORY_API_KEY: "local",
      TDAI_MEMORY_INSTANCE_ID: "instance-1",
      TDAI_MEMORY_TEAM_ID: "team-1",
      TDAI_MEMORY_AGENT_ID: "agent-1",
      TDAI_MEMORY_USER_ID: "user-1",
    }, "/home/test", "/bin/cursor-memory");

    expect(config).toMatchObject({
      rootDir: "/home/test/.memory-tencentdb/cursor",
      gatewayUrl: "http://127.0.0.1:8420",
      gatewayApiKey: "local",
      serviceId: "instance-1",
      teamId: "team-1",
      agentId: "agent-1",
      userId: "user-1",
      taskId: undefined,
      captureTimeoutMs: 60_000,
      recallTimeoutMs: 2_000,
      transcriptsRoot: "/home/test/.cursor/projects",
    });
  });

  // SDK client 创建前必须逐项校验, 防止写入默认或错误 isolation.
  it.each([
    ["gatewayUrl", { MEMORY_TENCENTDB_GATEWAY_URL: undefined }],
    ["gatewayApiKey", { MEMORY_TENCENTDB_GATEWAY_API_KEY: undefined }],
    ["serviceId", { MEMORY_TENCENTDB_SERVICE_ID: undefined }],
    ["teamId", { MEMORY_TENCENTDB_TEAM_ID: undefined }],
    ["agentId", { MEMORY_TENCENTDB_AGENT_ID: undefined }],
    ["userId", { MEMORY_TENCENTDB_USER_ID: undefined }],
  ])("缺少 %s 时拒绝创建 client", (field, missing) => {
    const env = {
      MEMORY_TENCENTDB_GATEWAY_URL: "https://memory.example.com",
      MEMORY_TENCENTDB_GATEWAY_API_KEY: "secret",
      MEMORY_TENCENTDB_SERVICE_ID: "service-1",
      MEMORY_TENCENTDB_TEAM_ID: "team-1",
      MEMORY_TENCENTDB_AGENT_ID: "agent-1",
      MEMORY_TENCENTDB_USER_ID: "user-1",
      ...missing,
    };
    const config = resolveCursorConfig(env, "/home/test", "/bin/cursor-memory");

    expect(() => createMemoryClient(config)).toThrow(field);
  });

  // 非法超时不得进入 SDK, 避免 NaN 或无限等待.
  it("非法数值回退为安全默认值", () => {
    const config = resolveCursorConfig({
      MEMORY_TENCENTDB_CURSOR_CAPTURE_TIMEOUT_MS: "-1",
      MEMORY_TENCENTDB_CURSOR_RECALL_TIMEOUT_MS: "bad",
    }, "/home/test", "/bin/cursor-memory");

    expect(config.captureTimeoutMs).toBe(60_000);
    expect(config.recallTimeoutMs).toBe(2_000);
  });

  // sessionStart 的可配置预算不得突破 2 秒硬上限.
  it("recall timeout 最大为 2 秒", () => {
    const config = resolveCursorConfig({
      MEMORY_TENCENTDB_CURSOR_RECALL_TIMEOUT_MS: "60000",
    }, "/home/test", "/bin/cursor-memory");

    expect(config.recallTimeoutMs).toBe(2_000);
  });
});
