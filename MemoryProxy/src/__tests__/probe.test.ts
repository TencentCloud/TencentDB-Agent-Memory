import { describe, it, expect, afterEach, vi } from "vitest";
import {
  resolveAgentModes,
  resolveAgentModesFor,
  agentsToAutoDetect,
  unroutableNativeProtocols,
  ALL_PROTOCOLS,
} from "../upstream/capability-probe.js";
import { KNOWN_AGENT_KINDS, resolveAgentAdapter } from "../agent-adapters/index.js";
import { log } from "../report/log.js";
import {
  applyAutoDetect,
  probeCapabilities,
  startAutoDetectLoop,
  __resetAutoDetectState,
} from "../upstream/capability-probe.js";
import { pickCachedCaps, readProbeCache, writeProbeCache } from "../upstream/probe-cache.js";
import { probeStatsToPrometheus, resetProbeStats } from "../upstream/probe-stats.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("agentsToAutoDetect：默认集合由客户端注册表派生（不只是三个内置）", () => {
    const list = agentsToAutoDetect({ upstream: {} } as never);
    for (const kind of KNOWN_AGENT_KINDS) expect(list).toContain(kind);
    // 本次补上的 Chat 原生客户端
    expect(list).toContain("dsh");
    expect(list).toContain("opencode");
    expect(list).toContain("pi");
  });
});

describe("按协议选路（不再维护客户端名单）", () => {
  /**
   * 改造前的参照实现：4 个客户端的手写字面量 + 分支。
   * 用它做逐组合回归，保证"换实现"没有改变既有 4 个客户端的任何行为。
   */
  const LEGACY_NATIVE: Record<string, ReadonlyArray<"chat" | "responses" | "anthropic">> = {
    workbuddy: ["chat", "responses"],
    "claude-code": ["anthropic"],
    codex: ["responses"],
    codebuddy: ["chat"],
  };
  const legacyModes = (
    native: ReadonlyArray<"chat" | "responses" | "anthropic">,
    caps: { chat: boolean; responses: boolean; anthropic: boolean },
  ): Record<string, boolean> => {
    const out: Record<string, boolean> = {};
    if (native.includes("anthropic")) {
      if (!caps.anthropic && caps.chat) out.anthropicToChat = true;
      else if (!caps.anthropic && !caps.chat && caps.responses) out.anthropicToResponses = true;
    }
    if (native.includes("responses")) {
      if (!caps.responses && caps.anthropic) out.responsesToAnthropic = true;
      else if (!caps.responses && !caps.anthropic && caps.chat) out.chatCompletions = true;
    }
    if (native.includes("chat")) {
      if (!caps.chat && caps.anthropic) out.chatToAnthropic = true;
    }
    return out;
  };
  const CAP_COMBOS = [false, true].flatMap((chat) =>
    [false, true].flatMap((responses) =>
      [false, true].map((anthropic) => ({ chat, responses, anthropic })),
    ),
  );

  it("既有 4 个客户端：8 种上游能力组合下选路结果与改造前完全一致", () => {
    for (const [agent, native] of Object.entries(LEGACY_NATIVE)) {
      for (const caps of CAP_COMBOS) {
        expect(resolveAgentModesFor(agent, caps)).toEqual(legacyModes(native, caps));
      }
    }
  });

  it("新声明的 Chat 原生客户端（dsh / opencode / pi）现在也参与选路与『无路可走』判定", () => {
    for (const agent of ["dsh", "opencode", "pi"]) {
      expect(resolveAgentModesFor(agent, { chat: false, responses: false, anthropic: true }))
        .toEqual({ chatToAnthropic: true });
      expect(resolveAgentModesFor(agent, { chat: true, responses: false, anthropic: false }))
        .toEqual({});
      expect(unroutableNativeProtocols(agent, { chat: false, responses: true, anthropic: false }))
        .toEqual(["chat"]);
    }
  });

  it("注册表完整性：每个已知 kind 都能解析到自己，且声明了合法的原生协议", () => {
    for (const kind of KNOWN_AGENT_KINDS) {
      const adapter = resolveAgentAdapter(kind);
      expect(adapter.agentKind).toBe(kind);
      const declared = adapter.nativeProtocols ?? [];
      expect(declared.length).toBeGreaterThan(0);
      for (const p of declared) expect(ALL_PROTOCOLS).toContain(p);
    }
    // 未注册的客户端不猜协议
    expect(resolveAgentAdapter("mystery").nativeProtocols ?? []).toEqual([]);
    expect(resolveAgentModesFor("mystery", { chat: false, responses: false, anthropic: true }))
      .toEqual({});
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
    expect(calls).toContain("https://up.example.com/v1/messages");
    // 根地址已带版本段时不再重复拼接（否则会多打一次无效请求 + 多一条 404 歧义告警）
    expect(calls).not.toContain("https://up.example.com/v1/v1/messages");
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

describe("applyAutoDetect（撤销 / 变更告警 / 缓存）", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    __resetAutoDetectState();
    resetProbeStats();
  });

  /** 按 URL 后缀返回状态码，未列出的返回 404；calls 记录实际发出的探测请求。 */
  const installFetch = (bySuffix: Record<string, number>, calls: string[] = []): string[] => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      for (const [suffix, status] of Object.entries(bySuffix)) {
        if (url.endsWith(suffix)) return new Response("{}", { status });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    return calls;
  };

  const makeConfig = (autoDetect: Record<string, unknown>) =>
    ({
      upstream: {
        url: "https://up.example.com/v1",
        apiKey: "k",
        agents: {},
        autoDetect,
      },
    }) as never;

  const agentsOf = (config: never) =>
    (config as { upstream: { agents: Record<string, Record<string, unknown>> } }).upstream.agents;

  it("能力回退时撤销上一轮由探测写入的开关，并计入变更计数", async () => {
    __resetAutoDetectState();
    resetProbeStats();
    const config = makeConfig({ enabled: true, timeoutMs: 50 });

    installFetch({ "/v1/messages": 200 }); // 上游仅支持 Anthropic
    await applyAutoDetect(config);
    expect(agentsOf(config).codex.responsesToAnthropic).toBe(true);

    installFetch({ "/chat/completions": 200 }); // 上游改为仅支持 Chat
    await applyAutoDetect(config, { useCache: false });
    const codex = agentsOf(config).codex;
    expect(codex.responsesToAnthropic).toBeUndefined(); // 旧开关被撤销
    expect(codex.chatCompletions).toBe(true); // 新开关写入
    expect(probeStatsToPrometheus()).toContain('tdai_upstream_probe_changes_total{agent="codex"}');
  });

  it("显式配置过开关的 agent 不参与探测，其配置不被覆盖也不被撤销", async () => {
    __resetAutoDetectState();
    const config = {
      upstream: {
        url: "https://up.example.com/v1",
        apiKey: "k",
        agents: { codex: { url: "https://explicit.example.com/v1", responsesToAnthropic: false } },
        autoDetect: { enabled: true, timeoutMs: 50 },
      },
    } as never;
    const calls = installFetch({ "/v1/messages": 200 });
    await applyAutoDetect(config);
    expect(agentsOf(config).codex.responsesToAnthropic).toBe(false);
    // 显式配置过开关的 agent 不参与探测：它的上游地址一次都没被请求过。
    expect(calls.some((u) => u.includes("explicit.example.com"))).toBe(false);
  });

  it("三端点全部探不通时保留上一次结论，并计入 failures", async () => {
    __resetAutoDetectState();
    resetProbeStats();
    const config = makeConfig({ enabled: true, timeoutMs: 50 });

    installFetch({ "/v1/messages": 200 });
    await applyAutoDetect(config);
    expect(agentsOf(config).codex.responsesToAnthropic).toBe(true);

    installFetch({}); // 全部 404（更像是上游临时不可用）
    await applyAutoDetect(config, { useCache: false });
    expect(agentsOf(config).codex.responsesToAnthropic).toBe(true); // 结论未被改坏
    expect(probeStatsToPrometheus()).toContain("tdai_upstream_probe_failures_total");
  });

  it("命中未过期缓存时不再向上游发探测请求", async () => {
    __resetAutoDetectState();
    resetProbeStats();
    const dir = mkdtempSync(join(tmpdir(), "probe-cache-"));
    const cacheFile = join(dir, "cache.json");
    try {
      const first = makeConfig({ enabled: true, timeoutMs: 50, cacheFile, cacheTtlMinutes: 720 });
      const firstCalls = installFetch({ "/v1/messages": 200 });
      await applyAutoDetect(first);
      expect(firstCalls.length).toBeGreaterThan(0);

      // 模拟重启：进程内状态清空、配置换成一份新的（agents 里没有任何开关）
      __resetAutoDetectState();
      resetProbeStats();
      const restarted = makeConfig({
        enabled: true,
        timeoutMs: 50,
        cacheFile,
        cacheTtlMinutes: 720,
      });
      const secondCalls = installFetch({ "/v1/messages": 200 });
      await applyAutoDetect(restarted);
      expect(secondCalls).toEqual([]); // 完全走缓存
      expect(agentsOf(restarted).codex.responsesToAnthropic).toBe(true);
      expect(probeStatsToPrometheus()).toContain("tdai_upstream_probe_cache_hits_total");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("缓存文件损坏时按未命中处理，不影响真实探测", async () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-cache-bad-"));
    const cacheFile = join(dir, "cache.json");
    try {
      writeFileSync(cacheFile, "{ 这不是合法 JSON");
      const config = { upstream: { autoDetect: { cacheFile } } } as never;
      expect(readProbeCache(config)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pickCachedCaps：URL 或模型名不匹配、缓存过期都视为未命中", () => {
    const entry = {
      codex: {
        url: "https://up.example.com/v1",
        probeModel: "glm-4.6",
        caps: { chat: false, responses: false, anthropic: true },
        updatedAt: Date.now() - 2 * 3_600_000,
      },
    };
    expect(
      pickCachedCaps(entry, "codex", "https://other.example.com/v1", "glm-4.6", 720),
    ).toBeNull();
    expect(pickCachedCaps(entry, "codex", "https://up.example.com/v1", "ping", 720)).toBeNull();
    expect(pickCachedCaps(entry, "codex", "https://up.example.com/v1", "glm-4.6", 60)).toBeNull();
    expect(pickCachedCaps(entry, "codex", "https://up.example.com/v1", "glm-4.6", 0)).toEqual({
      chat: false,
      responses: false,
      anthropic: true,
    });
  });

  it("writeProbeCache / readProbeCache 往返一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-cache-rt-"));
    const cacheFile = join(dir, "sub", "cache.json");
    try {
      const config = { upstream: { autoDetect: { cacheFile } } } as never;
      expect(
        writeProbeCache(config, {
          codex: {
            url: "u",
            probeModel: "m",
            caps: { chat: true, responses: false, anthropic: false },
            updatedAt: 1,
          },
        }),
      ).toBe(true);
      expect(readProbeCache(config).codex.caps).toEqual({
        chat: true,
        responses: false,
        anthropic: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("定期重探：仅在启用且间隔大于 0 时启动，句柄可停止", () => {
    expect(
      startAutoDetectLoop({ upstream: { autoDetect: { enabled: false, reprobeIntervalMinutes: 5 } } } as never),
    ).toBeNull();
    expect(
      startAutoDetectLoop({ upstream: { autoDetect: { enabled: true, reprobeIntervalMinutes: 0 } } } as never),
    ).toBeNull();
    const loop = startAutoDetectLoop(
      { upstream: { autoDetect: { enabled: true, reprobeIntervalMinutes: 30 } } } as never,
    );
    expect(loop).not.toBeNull();
    loop?.stop();
  });

  it("多个客户端共用同一上游时只探一次（探测按 url 去重）", async () => {
    __resetAutoDetectState();
    /** 只让 keep 里的客户端参与探测：其余 kind 显式关掉一个开关就会被跳过。 */
    const onlyProbing = (keep: string[], url: string) => {
      const agents: Record<string, Record<string, unknown>> = {};
      for (const kind of KNOWN_AGENT_KINDS) {
        if (!keep.includes(kind)) agents[kind] = { chatCompletions: false };
      }
      for (const kind of keep) agents[kind] = { url };
      return {
        upstream: { url, apiKey: "k", agents, autoDetect: { enabled: true, timeoutMs: 50 } },
      } as never;
    };

    const one = installFetch({ "/chat/completions": 200 });
    await applyAutoDetect(onlyProbing(["dsh"], "https://shared.example.com/v1"), {
      useCache: false,
    });

    __resetAutoDetectState();
    const three = installFetch({ "/chat/completions": 200 });
    await applyAutoDetect(
      onlyProbing(["dsh", "opencode", "pi"], "https://shared.example.com/v1"),
      { useCache: false },
    );

    expect(one.length).toBeGreaterThan(0);
    // 3 个客户端共用 1 个上游 = 同一批探测请求（探测结论是上游的性质）
    expect(three.length).toBe(one.length);
  });

  it("未声明原生协议的客户端：不给开关、不判无路可走，但会告警提示补声明", async () => {
    __resetAutoDetectState();
    const config = {
      upstream: {
        url: "https://up.example.com/v1",
        apiKey: "k",
        agents: { "my-agent": {} },
        autoDetect: { enabled: true, timeoutMs: 50 },
      },
    } as never;
    installFetch({ "/v1/messages": 200 }); // 上游仅支持 Anthropic
    const warns: string[] = [];
    const spy = vi.spyOn(log, "warn").mockImplementation((event: string) => {
      warns.push(event);
    });
    try {
      await applyAutoDetect(config);
    } finally {
      spy.mockRestore();
    }
    expect(warns).toContain("upstream.probe.undeclared_protocol");
    // 未声明协议 ⇒ 不写开关（保持现状），也不做"无路可走"判定
    expect(agentsOf(config)["my-agent"]?.chatToAnthropic).toBeUndefined();
    expect(warns).not.toContain("upstream.probe.unroutable");
  });
});
