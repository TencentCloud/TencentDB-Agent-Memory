import { describe, it, expect, afterEach } from "vitest";
import {
  resolveAgentModes,
  resolveAgentModesFor,
  agentsToAutoDetect,
  unroutableNativeProtocols,
} from "../upstream/capability-probe.js";
import { probeCapabilities } from "../upstream/capability-probe.js";

describe("resolveAgentModes（上游协议自动选路）", () => {
  it("上游仅支持 Chat：workbuddy 桌面走 chatCompletions，claude-code 走 anthropicToChat，codex 走 chatCompletions", () => {
    const m = resolveAgentModes({ chat: true, responses: false, anthropic: false });
    expect(m.workbuddy).toEqual({ chatCompletions: true });
    expect(m["claude-code"]).toEqual({ anthropicToChat: true });
    expect(m.codex).toEqual({ chatCompletions: true });
  });

  it("上游仅支持 Anthropic：workbuddy 走 chatToAnthropic，claude-code 直连，codex 走 responsesToAnthropic", () => {
    const m = resolveAgentModes({ chat: false, responses: false, anthropic: true });
    // WorkBuddy 桌面（Responses）与网页（Chat）两条路径都指向 Anthropic 上游。
    expect(m.workbuddy).toEqual({ chatToAnthropic: true, responsesToAnthropic: true });
    expect(m["claude-code"]).toEqual({});
    expect(m.codex).toEqual({ responsesToAnthropic: true });
  });

  it("上游支持 Chat 但不支持 Responses：workbuddy 桌面走 chatCompletions，网页直连", () => {
    const m = resolveAgentModes({ chat: true, responses: false, anthropic: false });
    expect(m.workbuddy).toEqual({ chatCompletions: true });
    expect(m["claude-code"]).toEqual({ anthropicToChat: true });
    expect(m.codex).toEqual({ chatCompletions: true });
  });

  it("上游仅支持 Responses：claude-code 走 anthropicToResponses，codex 直连，workbuddy 无路（chat 不支持且非 anthropic）", () => {
    const m = resolveAgentModes({ chat: false, responses: true, anthropic: false });
    expect(m["claude-code"]).toEqual({ anthropicToResponses: true });
    expect(m.codex).toEqual({});
    expect(m.workbuddy).toEqual({});
  });

  it("上游全支持：三个客户端都直连（客户端原生协议优先）", () => {
    const m = resolveAgentModes({ chat: true, responses: true, anthropic: true });
    expect(m.workbuddy).toEqual({});
    expect(m["claude-code"]).toEqual({});
    expect(m.codex).toEqual({});
  });
});

describe("resolveAgentModesFor / agentsToAutoDetect（泛化探测）", () => {
  it("codebuddy（Chat 原生）→ Anthropic 上游时自动补 chatToAnthropic", () => {
    expect(
      resolveAgentModesFor("codebuddy", { chat: false, responses: false, anthropic: true }),
    ).toEqual({ chatToAnthropic: true });
    expect(
      resolveAgentModesFor("codebuddy", { chat: true, responses: false, anthropic: false }),
    ).toEqual({});
  });

  it("未知客户端不自动给转换标志（等显式配置）", () => {
    expect(
      resolveAgentModesFor("my-custom-agent", { chat: false, responses: false, anthropic: true }),
    ).toEqual({});
  });

  it("agentsToAutoDetect：覆盖内置 + 配置中出现过的 agent，跳过已显式配置的", () => {
    const list = agentsToAutoDetect({
      upstream: {
        agents: {
          workbuddy: { chatCompletions: true },
          codebuddy: {},
          "my-agent": {},
        },
      },
    } as never);
    expect(list).toContain("claude-code");
    expect(list).toContain("codex");
    expect(list).toContain("codebuddy");
    expect(list).toContain("my-agent");
    expect(list).not.toContain("workbuddy");
  });

  it("agentsToAutoDetect：显式 false 同样是显式配置，autoDetect 不得再补开关", () => {
    const list = agentsToAutoDetect({
      upstream: {
        agents: {
          codex: { chatCompletions: false },
          "claude-code": { responsesToAnthropic: false },
          workbuddy: {},
        },
      },
    } as never);
    expect(list).not.toContain("codex");
    expect(list).not.toContain("claude-code");
    expect(list).toContain("workbuddy");
  });

  it("agentsToAutoDetect：upstream.agents 未配置时回落内置三个", () => {
    const list = agentsToAutoDetect({ upstream: {} } as never);
    expect(list).toContain("workbuddy");
    expect(list).toContain("claude-code");
    expect(list).toContain("codex");
  });
});

describe("probeCapabilities（URL 探测形态兼容）", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const installProbeMock = (): string[] => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({ type: "error", error: { type: "api_error", message: "no" } }),
        { status: 404 },
      );
    }) as typeof fetch;
    return calls;
  };

  it("裸根地址按 /chat/completions、/responses、/v1|messages 探测", async () => {
    const calls = installProbeMock();
    const caps = await probeCapabilities(
      "https://up.example.com/v1",
      "key",
      50,
    );
    expect(caps).toEqual({ chat: false, responses: false, anthropic: false });
    expect(calls).toContain("https://up.example.com/v1/chat/completions");
    expect(calls).toContain("https://up.example.com/v1/responses");
    expect(calls).toContain("https://up.example.com/v1/v1/messages");
    expect(calls).toContain("https://up.example.com/v1/messages");
  });

  it("完整端点地址（…/v2/chat/completions）不再拼出双端点，完整端点自身会被探测", async () => {
    const calls = installProbeMock();
    await probeCapabilities(
      "https://up.example.com/v2/chat/completions",
      "key",
      50,
    );
    expect(calls).not.toContain(
      "https://up.example.com/v2/chat/completions/chat/completions",
    );
    expect(calls).toContain("https://up.example.com/v2/chat/completions");
    expect(calls).toContain("https://up.example.com/v2/responses");
    expect(calls).toContain("https://up.example.com/v2/messages");
  });
});

describe("probeEndpoint（鉴权头与探测模型）", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const installCaptureMock = (): Array<{
    url: string;
    headers: Record<string, string>;
    body: string;
  }> => {
    const reqs: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      reqs.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body ?? ""),
      });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    return reqs;
  };

  it("Anthropic 探测用 x-api-key + anthropic-version，OpenAI 家族用 Bearer", async () => {
    const reqs = installCaptureMock();
    await probeCapabilities("https://up.example.com/v1", "sk-test", 50);

    const anthropicReq = reqs.find((r) => r.url.endsWith("/v1/messages"));
    expect(anthropicReq?.headers["x-api-key"]).toBe("sk-test");
    expect(anthropicReq?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(anthropicReq?.headers.authorization).toBeUndefined();

    const chatReq = reqs.find((r) => r.url.endsWith("/chat/completions"));
    expect(chatReq?.headers.authorization).toBe("Bearer sk-test");
  });

  it("探测模型名可配置（避开『未知模型 → 404』被误判成端点不存在）", async () => {
    const reqs = installCaptureMock();
    await probeCapabilities("https://up.example.com/v1", "sk-test", 50, "glm-4.6");
    expect(reqs.length).toBeGreaterThan(0);
    for (const r of reqs) expect(r.body).toContain('"model":"glm-4.6"');
    expect(reqs.map((r) => r.body).join()).not.toContain('"model":"ping"');
  });
});

describe("unroutableNativeProtocols（启动期『无路可走』告警）", () => {
  it("Responses-only 上游：chat 原生客户端无路可走（无 chat→Responses 实现）", () => {
    expect(
      unroutableNativeProtocols("workbuddy", {
        chat: false,
        responses: true,
        anthropic: false,
      }),
    ).toEqual(["chat"]);
  });

  it("三协议全支持 / 有可用转换方向时均不告警", () => {
    expect(
      unroutableNativeProtocols("codex", { chat: false, responses: true, anthropic: false }),
    ).toEqual([]);
    expect(
      unroutableNativeProtocols("codex", { chat: false, responses: false, anthropic: true }),
    ).toEqual([]);
    expect(
      unroutableNativeProtocols("claude-code", { chat: true, responses: false, anthropic: false }),
    ).toEqual([]);
  });

  it("未知客户端不判定（等显式配置）", () => {
    expect(
      unroutableNativeProtocols("mystery", { chat: false, responses: false, anthropic: false }),
    ).toEqual([]);
  });
});
