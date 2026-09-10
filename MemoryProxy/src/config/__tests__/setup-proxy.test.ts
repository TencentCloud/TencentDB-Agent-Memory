import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function configure(agent = "openclaw", flags: string[] = [], existing?: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "agent-setup-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "config.json");
  if (existing) writeFileSync(path, JSON.stringify(existing));
  const output = execFileSync("bash", [
    join(repository, "agents/setup-proxy.sh"), "--non-interactive",
    "--proxy-host", "http://proxy.example:8096", "--instance-id", "default",
    "--user-key", "setup-test-secret", "--model", "test-model", "--agent", agent,
    "--config-path", path, ...flags,
  ], { encoding: "utf8", env: { ...process.env, HOME: directory } });
  expect(output).not.toContain("setup-test-secret");
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("Agent 配置向导的 Session Bridge 兼容性", () => {
  it("两个分发位置使用相同脚本", () => {
    expect(readFileSync(join(repository, "agents/skills/setup-proxy/setup-proxy.sh"), "utf8"))
      .toBe(readFileSync(join(repository, "agents/setup-proxy.sh"), "utf8"));
  });

  it("默认不生成静态身份，也不替用户安装或授权插件", () => {
    const config = configure();
    expect(config.models.providers["memory-proxy"]).toMatchObject({
      baseUrl: "http://proxy.example:8096/openclaw/default/v1",
      authHeader: true,
      api: "openai-completions",
      headers: {},
    });
    expect(config.plugins).toBeUndefined();
  });

  it("迁移时删除旧静态身份，保留其他配置和自定义 header", () => {
    const config = configure("openclaw", [], {
      plugins: { entries: { custom: { enabled: true } } },
      models: { providers: {
        other: { baseUrl: "https://other.example" },
        "memory-proxy": {
          timeout: 123,
          request: { allowPrivateNetwork: true },
          headers: { "X-Conversation-ID": "stale", "x-team-id": "old-team", "X-Custom": "kept" },
        },
      } },
    });
    expect(config.models.providers.other).toEqual({ baseUrl: "https://other.example" });
    expect(config.models.providers["memory-proxy"].headers).toEqual({ "X-Custom": "kept" });
    expect(config.models.providers["memory-proxy"].request).toEqual({ allowPrivateNetwork: true });
    expect(config.plugins.entries.custom.enabled).toBe(true);
  });

  it("显式会话 ID 保留旧静态模式，Task 仍可省略", () => {
    const config = configure("openclaw", ["--conv-id", "legacy-session", "--team-id", "team-a", "--agent-id", "agent-a"]);
    expect(config.models.providers["memory-proxy"].headers).toEqual({
      "x-conversation-id": "legacy-session", "x-team-id": "team-a", "x-agent-id": "agent-a",
    });
  });

  it("兼容开关可生成会话 ID，并保留显式 Task", () => {
    const config = configure("openclaw", ["--openclaw-static-headers", "--team-id", "team-a", "--agent-id", "agent-a", "--task-id", "task-a"]);
    expect(config.models.providers["memory-proxy"].headers).toMatchObject({ "x-task-id": "task-a" });
    expect(config.models.providers["memory-proxy"].headers["x-conversation-id"]).toMatch(/^conv-/);
  });

  it("Bridge 也可搭配静态 Team/Agent 预选，不生成静态会话 ID", () => {
    const config = configure("openclaw", ["--team-id", "team-a", "--agent-id", "agent-a"]);
    expect(config.models.providers["memory-proxy"].headers).toEqual({ "x-team-id": "team-a", "x-agent-id": "agent-a" });
  });

  it.each(["claude-code", "codebuddy", "workbuddy"])("不向其他 Agent 写入 OpenClaw 配置：%s", (agent) => {
    const config = configure(agent);
    expect(JSON.stringify(config)).not.toContain("openclaw");
    expect(JSON.stringify(config)).toContain(`/${agent}/default`);
  });
});
