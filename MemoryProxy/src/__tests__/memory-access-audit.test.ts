/**
 * memory-access 审计的**读路径**用例。
 *
 * 背景：#1270 落地审计线时只覆盖了写路径（`tdai/recorder.ts` 的 `action=write`），
 * 设计文档把 recall / search 读路径标为后续项。本文件覆盖后续项落地后的行为：
 *   - L1 自动召回（tdai-l1-recall-injector）→ `action=recall`
 *   - memory-bridge 只读子路径 → `action=search | query | read`
 *
 * 断言方式：把 `auditMemoryAccess`（唯一落盘入口）替换成 spy，只验证"发了哪些
 * 审计事件"，不依赖文件写入时序。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("../audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit.js")>();
  return { ...actual, auditMemoryAccess: vi.fn() };
});

import { auditMemoryAccess } from "../audit.js";
import { auditActionForSubpath, createMemoryBridgeHandler } from "../memory/memory-bridge.js";
import { TdaiL1RecallInjector } from "../injection/injectors/tdai-l1-recall-injector.js";
import { getSessionStore } from "../session/store.js";
import type { AgentContext } from "../injection/types.js";
import type { SessionInitState } from "../session/types.js";
import type { TdaiClient } from "../tdai/client.js";
import type { ProxyConfig } from "../types.js";

const auditSpy = vi.mocked(auditMemoryAccess);

beforeEach(() => {
  auditSpy.mockClear();
});

describe("auditActionForSubpath：只读子路径 → audit action", () => {
  it("search / query / read 三类各自映射", () => {
    expect(auditActionForSubpath("atomic/search")).toBe("search");
    expect(auditActionForSubpath("conversation/search")).toBe("search");
    expect(auditActionForSubpath("atomic/query")).toBe("query");
    expect(auditActionForSubpath("conversation/query")).toBe("query");
    expect(auditActionForSubpath("scenario/ls")).toBe("read");
    expect(auditActionForSubpath("scenario/read")).toBe("read");
  });
});

describe("L1 自动召回 → action=recall", () => {
  const identitySession = {
    session_id: "s1",
    team_id: "t1",
    agent_id: "a1",
    user_id: "u1",
    task_id: "task-1",
  };

  function makeCtx(): AgentContext {
    return {
      messages: [
        {
          role: "user",
          blocks: [{ type: "text", content: "上次那个接口是怎么改的" }],
        },
      ],
      tools: [],
      requestParams: {},
      metadata: {
        protocol: "anthropic",
        traceId: "trace-abc",
        keyId: "k1",
        modelId: "m1",
        stream: false,
        agentSource: "claude-code",
        custom: { userKey: "uk-1", session: identitySession },
      },
    };
  }

  it("按命名空间记一条 recall，result = 命中条数", async () => {
    const client = {
      searchL1ForCtx: vi.fn(async () => [{ content: "接口改动记录", score: 0.9, type: "decision" }]),
    } as unknown as TdaiClient;
    const injector = new TdaiL1RecallInjector(client, null, undefined, 5, null);

    const blocks = await injector.execute(makeCtx());

    expect(blocks).toHaveLength(1);
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUser: "u1",
        actorAgent: "a1",
        action: "recall",
        target: "t1:a1:task-1",
        result: 1,
        sessionKey: "s1",
        scope: "normal",
        traceId: "trace-abc",
      }),
    );
  });

  it("命中 0 条也记（区分「查了没命中」与「压根没查」）", async () => {
    const client = { searchL1ForCtx: vi.fn(async () => []) } as unknown as TdaiClient;
    const injector = new TdaiL1RecallInjector(client, null, undefined, 5, null);

    const blocks = await injector.execute(makeCtx());

    expect(blocks).toHaveLength(0);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "recall", result: 0, target: "t1:a1:task-1" }),
    );
  });

  it("缺 identity / 无 user 消息时不记（没有真实发生读）", async () => {
    const client = { searchL1ForCtx: vi.fn(async () => []) } as unknown as TdaiClient;
    const injector = new TdaiL1RecallInjector(client, null, undefined, 5, null);
    const ctx = makeCtx();
    ctx.metadata.custom = {};

    await expect(injector.execute(ctx)).resolves.toEqual([]);
    expect(auditSpy).not.toHaveBeenCalled();
  });
});

describe("memory-bridge 只读子路径 → action=search / read", () => {
  const config = {
    coreSkill: {
      endpoint: "http://kernel.local",
      serviceToken: "tok",
      serviceId: "svc",
      timeoutMs: 1000,
    },
    tdai: { serviceId: "svc" },
  } as unknown as ProxyConfig;

  async function seedSession(): Promise<void> {
    // 不带 user_key：让 resolveMemoryCtxs 直接返回 self，避免打控制面
    await getSessionStore().set("codebuddy:s1", {
      status: "initialized",
      keyId: "codebuddy:s1",
      startedAt: Date.now(),
      attemptCount: 0,
      sessionInfo: {
        session_id: "s1",
        team_id: "t1",
        agent_id: "a1",
        user_id: "u1",
        task_id: "task-1",
        space_id: "sp",
      },
    } as unknown as SessionInitState);
  }

  function makeApp(fetcher: typeof fetch): Hono {
    const handler = createMemoryBridgeHandler(config, { fetcher });
    const app = new Hono();
    app.post("/memory-bridge/v3/*", (c) => handler(c));
    return app;
  }

  it("search：记 action=search、result=命中条数、target=被读命名空间", async () => {
    await seedSession();
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({ code: 0, data: { items: [{ id: "m1", score: 0.9 }, { id: "m2", score: 0.8 }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const app = makeApp(fetcher);

    const res = await app.request("/memory-bridge/v3/atomic/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-conversation-id": "s1" },
      body: JSON.stringify({ query: "接口怎么改" }),
    });

    expect(res.status).toBe(200);
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUser: "u1",
        actorAgent: "a1",
        action: "search",
        target: "t1:a1:task-1",
        result: 2,
        sessionKey: "s1",
        scope: "normal",
        traceId: "memory-bridge:s1",
      }),
    );
  });

  it("read：非 JSON body 无法计数时回落 http_<status>；调用方透传 traceId 时用它", async () => {
    await seedSession();
    const fetcher = vi.fn(async () =>
      new Response("场景正文（非 JSON）", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    ) as unknown as typeof fetch;
    const app = makeApp(fetcher);

    const res = await app.request("/memory-bridge/v3/scenario/read", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-conversation-id": "s1",
        "x-tdai-trace-id": "trace-from-caller",
      },
      body: JSON.stringify({ path: "scene/a.md" }),
    });

    expect(res.status).toBe(200);
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "read",
        target: "t1:a1:task-1",
        result: "http_200",
        traceId: "trace-from-caller",
      }),
    );
  });

  it("上游读失败（非 2xx，直通路径）不记（失败由 bridge 的 reject/telemetry 线负责）", async () => {
    await seedSession();
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ code: 50001, message: "boom" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const app = makeApp(fetcher);

    // 用直通路径（非 multi-search 聚合）验证：聚合路径即使上游 500 也会返回 200 envelope
    const res = await app.request("/memory-bridge/v3/scenario/read", {
      method: "POST",
      headers: { "content-type": "application/json", "x-conversation-id": "s1" },
      body: JSON.stringify({ path: "scene/a.md" }),
    });

    expect(res.status).toBe(500);
    expect(auditSpy).not.toHaveBeenCalled();
  });
});
