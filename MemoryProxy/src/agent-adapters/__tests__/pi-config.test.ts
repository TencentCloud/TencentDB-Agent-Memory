import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface PiProviderExample {
  baseUrl?: unknown;
  api?: unknown;
  headers?: Record<string, unknown>;
  compat?: Record<string, unknown>;
}

/**
 * 按 JSON 文件读取示例而非作为模块 import：既贴合 Pi 加载 `models.json` 的真实
 * 路径，也能防止文档调整后把可复制配置改成不合法的 JSON。
 */
async function loadProviderExample(): Promise<PiProviderExample> {
  const configUrl = new URL("../../../../adapters/pi/models.example.json", import.meta.url);
  const config = JSON.parse(await readFile(configUrl, "utf8")) as {
    providers?: Record<string, PiProviderExample>;
  };
  return config.providers?.["tdai-memory"] ?? {};
}

describe("Pi zero-code provider example", () => {
  it("routes standard OpenAI completions through the Pi MemoryProxy prefix", async () => {
    const provider = await loadProviderExample();
    expect(provider.api).toBe("openai-completions");
    expect(provider.baseUrl).toBe("http://127.0.0.1:8096/pi/<space-id>/v1");
  });

  it("provides dynamic session identity and the complete static asset preset", async () => {
    const provider = await loadProviderExample();

    // openrouter affinity 格式会发送动态 `x-session-id`。Proxy 以它作为会话键；
    // 如果这里改成静态 Header，所有 Pi 对话会错误共享同一个记忆 Session。
    expect(provider.compat).toMatchObject({
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: "openrouter",
    });

    // Pi 的 Session Init 明确采用无 Form 模式，三个 preset 必须成组提供；部分
    // preset 无法通过向客户端弹出资产选择工具来补全。
    expect(provider.headers).toMatchObject({
      "x-team-id": "$TDAI_MEMORY_TEAM_ID",
      "x-agent-id": "$TDAI_MEMORY_AGENT_ID",
      "x-task-id": "$TDAI_MEMORY_TASK_ID",
    });
  });
});
