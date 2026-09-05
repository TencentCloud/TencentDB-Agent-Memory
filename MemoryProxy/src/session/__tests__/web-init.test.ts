import { createHash } from "node:crypto";
import { Script } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import * as agentAdapters from "../../agent-adapters/index.js";
import type { BindingRepo, SessionBinding } from "../../db/binding-repo.js";
import {
  __resetSessionRepoForTests,
  setSessionRepo,
  type SessionRepo,
} from "../../db/sessionRepo.js";
import { MetadataClient, setMetadataClient } from "../../meta/client.js";
import { createApp } from "../../server.js";
import type { ProxyConfig } from "../../types.js";
import type { SessionInitState } from "../types.js";
import { __resetSessionStoreForTests, getSessionStore, SessionStore } from "../store.js";
import {
  setWebSessionInitService,
  WebSessionInitService,
  type WebInitChallengeInput,
  type WebSessionInitServiceOptions,
} from "../web-init.js";

class MemoryBindingRepo implements BindingRepo {
  readonly values = new Map<string, SessionBinding>();
  // values 只能看到最终结果；单独记录调用次数，才能证明并发或 stale completion
  // 没有先写一次错误 binding、随后又被正确值覆盖。
  readonly putCalls: Array<{ spaceId: string; sessionId: string; binding: SessionBinding }> = [];

  async getBinding(spaceId: string, sessionId: string): Promise<SessionBinding | null> {
    return this.values.get(`${spaceId}:${sessionId}`) ?? null;
  }
  async putBinding(spaceId: string, sessionId: string, binding: SessionBinding): Promise<void> {
    this.putCalls.push({ spaceId, sessionId, binding });
    this.values.set(`${spaceId}:${sessionId}`, binding);
  }
  async deleteBinding(spaceId: string, sessionId: string): Promise<void> {
    this.values.delete(`${spaceId}:${sessionId}`);
  }
  async touchLastSeen(): Promise<void> {}
}

class MemorySessionRepo implements SessionRepo {
  readonly values = new Map<string, SessionInitState>();

  async upsert(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    state: SessionInitState,
  ): Promise<void> {
    this.values.set(`${spaceId}:${userId}:${agentSource}:${sessionId}`, state);
  }
  async getBySessionId(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<SessionInitState | null> {
    return this.values.get(`${spaceId}:${userId}:${agentSource}:${sessionId}`) ?? null;
  }
  deleteBySessionId(spaceId: string, userId: string, agentSource: string, sessionId: string): void {
    this.values.delete(`${spaceId}:${userId}:${agentSource}:${sessionId}`);
  }
  async loadAllInitialized() { return []; }
}

const metadata = {
  async listTeams(_userId: string) {
    return [
      { team_id: "team-a", name: "Team A" },
      { team_id: "team-b", name: "Team B" },
    ];
  },
  async listAgents(teamId: string, _ownerUserId?: string) {
    return teamId === "team-a"
      ? [{ agent_id: "agent-a", team_id: teamId, name: "Agent A", prompt: "Be precise." }]
      : [{ agent_id: "agent-b", team_id: teamId, name: "Agent B" }];
  },
  async listTasks(teamId: string) {
    return teamId === "team-a"
      ? [{ task_id: "task-a", team_id: teamId, title: "Task A" }]
      : [{ task_id: "task-b", team_id: teamId, title: "Task B" }];
  },
  async getAgent(agentId: string) {
    return agentId === "agent-a"
      ? { agent_id: agentId, team_id: "team-a", name: "Agent A", prompt: "Be precise." }
      : { agent_id: agentId, team_id: "team-b", name: "Agent B" };
  },
  async getTask(taskId: string) {
    return taskId === "task-a"
      ? { task_id: taskId, team_id: "team-a", title: "Task A" }
      : { task_id: taskId, team_id: "team-b", title: "Task B" };
  },
};

/**
 * 手动控制 Promise 何时恢复，用于把 complete() 精确停在 metadata await 内。
 * 普通 resolved mock 会在微任务队列里立刻继续，无法稳定构造真正的并发窗口。
 */
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * 直接从 service 签发 challenge，避免每个生命周期测试都先经过完整 HTTP 首请求。
 * HTTP 编码由下方 route tests 独立覆盖；这里专注 token、SessionStore 和 binding 不变量。
 */
function issueChallenge(
  service: WebSessionInitService,
  store: SessionStore,
  metadataClient: WebInitChallengeInput["metadataClient"] = metadata,
  sessionKey = "conversation-a",
  agentSource = "openclaw",
): string {
  const issued = service.issue({
    compositeKey: `${agentSource}:${sessionKey}`,
    sessionKey,
    identity: { userId: "user-a", agentSource, sessionId: sessionKey, spaceId: "space-a" },
    userKey: "secret-user-key",
    metadataClient,
    store,
  });
  if (!issued.ok) throw new Error(`Unable to issue challenge: ${issued.code}`);
  return issued.value.token;
}

function config(): ProxyConfig {
  const value = structuredClone(DEFAULT_CONFIG);
  value.sessionInit.enabled = true;
  value.injection.enabled = false;
  value.extraction.enabled = false;
  value.costGuard.enabled = false;
  value.upstream.url = "http://upstream.test/v1/chat/completions";
  return value;
}

function chatRequest(
  conversationId: string,
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-conversation-id": conversationId,
      "x-user-id": "user-a",
      ...headers,
    },
    body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "Hello" }] }),
  };
}

describe("Web Session Init service", () => {
  it("allows Task to be omitted and persists through SessionStore/BindingRepo", async () => {
    const repo = new MemoryBindingRepo();
    const store = new SessionStore(30_000, undefined, repo);
    const service = new WebSessionInitService({ tokenFactory: () => "opaque-token" });
    const issued = service.issue({
      compositeKey: "openclaw:conversation-a",
      sessionKey: "conversation-a",
      identity: { userId: "user-a", agentSource: "openclaw", sessionId: "conversation-a", spaceId: "space-a" },
      userKey: "secret-user-key",
      metadataClient: metadata as any,
      store,
    });
    expect(issued).toEqual(expect.objectContaining({ ok: true }));

    const completed = await service.complete("opaque-token", {
      teamId: "team-a",
      agentId: "agent-a",
    });

    expect(completed).toEqual({ ok: true, value: null });
    expect(store.get("openclaw:conversation-a")?.sessionInfo).toMatchObject({
      session_id: "conversation-a",
      team_id: "team-a",
      agent_id: "agent-a",
      task_id: undefined,
      user_id: "user-a",
    });
    expect(repo.values.get("space-a:conversation-a")).toMatchObject({
      outcome: "initialized",
      teamId: "team-a",
      agentId: "agent-a",
      taskId: undefined,
      agentSource: "openclaw",
    });
  });

  it("rejects invalid and expired tokens", () => {
    let now = 100;
    const service = new WebSessionInitService({
      ttlMs: 50,
      now: () => now,
      tokenFactory: () => "expiring-token",
    });
    const store = new SessionStore();
    service.issue({
      compositeKey: "openclaw:conversation-a",
      sessionKey: "conversation-a",
      identity: { userId: "user-a", agentSource: "openclaw", sessionId: "conversation-a", spaceId: "space-a" },
      metadataClient: metadata as any,
      store,
    });

    expect(service.inspect("not-a-token")).toMatchObject({ ok: false, code: "invalid_token" });
    now = 151;
    expect(service.inspect("expiring-token")).toMatchObject({ ok: false, code: "expired_token" });
  });

  it("keeps one active challenge and cannot overwrite an initialized session", async () => {
    const store = new SessionStore();
    let tokenNumber = 0;
    const service = new WebSessionInitService({ tokenFactory: () => `token-${++tokenNumber}` });
    const input = {
      compositeKey: "openclaw:conversation-a",
      sessionKey: "conversation-a",
      identity: { userId: "user-a", agentSource: "openclaw", sessionId: "conversation-a", spaceId: "space-a" },
      metadataClient: metadata as any,
      store,
    };
    const first = service.issue(input);
    const second = service.issue(input);
    expect(first).toEqual(second);

    expect(await service.complete("token-1", { teamId: "team-a", agentId: "agent-a" }))
      .toEqual({ ok: true, value: null });
    expect(await service.complete("token-1", { teamId: "team-b", agentId: "agent-b" }))
      .toMatchObject({ ok: false });
    expect(service.issue(input)).toMatchObject({ ok: false, code: "already_initialized" });
    expect(store.get("openclaw:conversation-a")?.sessionInfo).toMatchObject({
      team_id: "team-a",
      agent_id: "agent-a",
    });
  });

  it("rejects a truly concurrent completion before metadata resolves and writes one binding", async () => {
    const teams = deferred<Awaited<ReturnType<typeof metadata.listTeams>>>();
    const repo = new MemoryBindingRepo();
    const store = new SessionStore(30_000, undefined, repo);
    const listTeams = vi.fn(() => teams.promise);
    const service = new WebSessionInitService({ tokenFactory: () => "concurrent-token" });
    const token = issueChallenge(service, store, { ...metadata, listTeams });

    const first = service.complete(token, { teamId: "team-a", agentId: "agent-a" });
    expect(listTeams).toHaveBeenCalledTimes(1);

    // 不等待 first 完成才是真正的 concurrent completion；第二次调用必须看到 completing guard。
    const second = await service.complete(token, { teamId: "team-b", agentId: "agent-b" });
    expect(second).toMatchObject({ ok: false, code: "completion_in_progress" });
    expect(repo.putCalls).toHaveLength(0);

    teams.resolve(await metadata.listTeams("user-a"));
    expect(await first).toEqual({ ok: true, value: null });
    expect(repo.putCalls).toHaveLength(1);
    expect(repo.values.get("space-a:conversation-a")).toMatchObject({
      teamId: "team-a",
      agentId: "agent-a",
    });
  });

  it("does not let a stale completion overwrite a session initialized during metadata wait", async () => {
    const teams = deferred<Awaited<ReturnType<typeof metadata.listTeams>>>();
    const repo = new MemoryBindingRepo();
    const store = new SessionStore(30_000, undefined, repo);
    const service = new WebSessionInitService({ tokenFactory: () => "stale-token" });
    const token = issueChallenge(service, store, { ...metadata, listTeams: () => teams.promise });

    const staleCompletion = service.complete(token, { teamId: "team-a", agentId: "agent-a" });

    // 模拟等待窗口内由其他合法路径完成 binding，并通过正式契约同时写入 L1/L2。
    store.bind("openclaw:conversation-a", {
      userId: "user-a",
      agentSource: "openclaw",
      sessionId: "conversation-a",
      spaceId: "space-a",
    });
    await store.set("openclaw:conversation-a", {
      status: "initialized",
      keyId: "conversation-a",
      startedAt: Date.now(),
      attemptCount: 0,
      userId: "user-a",
      sessionInfo: {
        session_id: "conversation-a",
        team_id: "team-b",
        agent_id: "agent-b",
        user_id: "user-a",
        user_key: "external-user-key",
        space_id: "space-a",
        created_at: new Date().toISOString(),
      },
      agentDetail: { id: "agent-b", name: "Agent B" },
      taskDetail: null,
      bypassed: false,
    });

    // metadata 恢复后，旧 completion 必须在最终写入前重新读取 terminal state，
    // 返回冲突并保留 team-b；putCalls=1 证明它没有产生第二次覆盖写。
    teams.resolve(await metadata.listTeams("user-a"));
    expect(await staleCompletion).toMatchObject({ ok: false, code: "already_initialized" });
    expect(store.get("openclaw:conversation-a")?.sessionInfo).toMatchObject({
      team_id: "team-b",
      agent_id: "agent-b",
    });
    expect(repo.values.get("space-a:conversation-a")).toMatchObject({
      teamId: "team-b",
      agentId: "agent-b",
    });
    expect(repo.putCalls).toHaveLength(1);
  });

  it("returns expired_token without writing when the token expires during metadata validation", async () => {
    let now = 100;
    const teams = deferred<Awaited<ReturnType<typeof metadata.listTeams>>>();
    const repo = new MemoryBindingRepo();
    const store = new SessionStore(30_000, undefined, repo);
    const service = new WebSessionInitService({
      ttlMs: 50,
      now: () => now,
      tokenFactory: () => "expires-during-metadata",
    });
    const token = issueChallenge(service, store, {
      ...metadata,
      listTeams: () => teams.promise,
    });

    // 最终写入门禁必须同时保留 challenge identity 防护和 expired/invalid 语义区别。
    const completion = service.complete(token, { teamId: "team-a", agentId: "agent-a" });
    now = 151;
    teams.resolve(await metadata.listTeams("user-a"));

    expect(await completion).toMatchObject({ ok: false, code: "expired_token" });
    expect(store.get("openclaw:conversation-a")).toBeUndefined();
    expect(repo.putCalls).toHaveLength(0);
  });

  // selection/metadata 失败属于可修正错误：finally 必须释放 completing，但不能消费
  // challenge。每个 case 先验证零写入，再用同一 token 做一次正确、Task 省略的重试。
  it.each([
    {
      name: "invalid Team",
      selection: { teamId: "team-missing", agentId: "agent-a" },
      expectedCode: "invalid_selection",
      metadataClient: () => metadata,
    },
    {
      name: "invalid Agent",
      selection: { teamId: "team-a", agentId: "agent-missing" },
      expectedCode: "invalid_selection",
      metadataClient: () => metadata,
    },
    {
      name: "invalid Task",
      selection: { teamId: "team-a", agentId: "agent-a", taskId: "task-missing" },
      expectedCode: "invalid_selection",
      metadataClient: () => metadata,
    },
    {
      name: "metadata unavailable",
      selection: { teamId: "team-a", agentId: "agent-a" },
      expectedCode: "metadata_unavailable",
      metadataClient: () => {
        let failed = false;
        return {
          ...metadata,
          async listTeams(userId: string) {
            if (!failed) {
              failed = true;
              throw new Error("metadata offline");
            }
            return metadata.listTeams(userId);
          },
        };
      },
    },
  ])("keeps the challenge retryable after $name", async ({ selection, expectedCode, metadataClient }) => {
    const repo = new MemoryBindingRepo();
    const store = new SessionStore(30_000, undefined, repo);
    const service = new WebSessionInitService({ tokenFactory: () => "retry-token" });
    const token = issueChallenge(service, store, metadataClient());

    expect(await service.complete(token, selection)).toMatchObject({ ok: false, code: expectedCode });
    expect(store.get("openclaw:conversation-a")).toBeUndefined();
    expect(repo.putCalls).toHaveLength(0);
    expect(service.inspect(token)).toMatchObject({ ok: true });

    expect(await service.complete(token, { teamId: "team-a", agentId: "agent-a" }))
      .toEqual({ ok: true, value: null });
    expect(repo.putCalls).toHaveLength(1);
  });

  it("isolates pending challenges and completion across sessions", async () => {
    const store = new SessionStore();
    let tokenNumber = 0;
    const service = new WebSessionInitService({ tokenFactory: () => `isolated-${++tokenNumber}` });
    const issue = (sessionKey: string) => service.issue({
      compositeKey: `openclaw:${sessionKey}`,
      sessionKey,
      identity: { userId: "user-a", agentSource: "openclaw", sessionId: sessionKey, spaceId: "space-a" },
      metadataClient: metadata as any,
      store,
    });

    expect(issue("conversation-a")).toMatchObject({ ok: true, value: { token: "isolated-1" } });
    expect(issue("conversation-b")).toMatchObject({ ok: true, value: { token: "isolated-2" } });
    expect(await service.complete("isolated-1", { teamId: "team-a", agentId: "agent-a" }))
      .toEqual({ ok: true, value: null });

    expect(store.get("openclaw:conversation-a")?.status).toBe("initialized");
    expect(store.get("openclaw:conversation-b")).toBeUndefined();
    expect(service.inspect("isolated-2")).toMatchObject({ ok: true });
  });
});

describe("Web Session Init routes and client integration", () => {
  let bindingRepo: MemoryBindingRepo;
  let sessionRepo: MemorySessionRepo;

  beforeEach(() => {
    __resetSessionStoreForTests();
    sessionRepo = new MemorySessionRepo();
    setSessionRepo(sessionRepo);
    setWebSessionInitService(null);
    setMetadataClient(metadata as any);
    bindingRepo = new MemoryBindingRepo();
    getSessionStore().setBindingRepo(bindingRepo);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("http://upstream.test/")) {
        return new Response(JSON.stringify({
          id: "upstream-response",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "Upstream OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setMetadataClient(null);
    setWebSessionInitService(null);
    __resetSessionStoreForTests();
    __resetSessionRepoForTests();
    vi.unstubAllGlobals();
  });

  function routeChallenge(
    metadataClient: WebInitChallengeInput["metadataClient"] = metadata,
    options: WebSessionInitServiceOptions = {},
  ) {
    const service = new WebSessionInitService({ tokenFactory: () => "route-token", ...options });
    const token = issueChallenge(service, getSessionStore(), metadataClient);
    setWebSessionInitService(service);
    const app = createApp(config());
    const pathname = `/session-init/${token}`;
    return {
      service, token, app, pathname,
      complete(body = JSON.stringify({ teamId: "team-a", agentId: "agent-a" })) {
        return app.request(`http://localhost${pathname}/complete`, {
          method: "POST", headers: { "content-type": "application/json" }, body,
        });
      },
    };
  }

  async function pageRuntime() {
    const { app, pathname } = routeChallenge(metadata, { tokenFactory: () => "ui-token" });
    const html = await (await app.request(`http://localhost${pathname}`)).text();
    const elements = Object.fromEntries([
      "team", "agent", "task", "form", "connect", "status", "status-title", "status-detail", "retry",
    ].map((id) => [id, {
      value: "", textContent: "", disabled: true, hidden: false, className: "",
      replaceChildren(...options: Array<{ value: string }>) { this.value = options[0]?.value ?? ""; },
      append: vi.fn(),
      setAttribute: vi.fn(),
      addEventListener: vi.fn(),
    }]));
    const fetchPage = vi.fn((path: string, init?: RequestInit) => app.request(`http://localhost${path}`, init));
    const dispatch = (id: string) => elements[id].addEventListener.mock.calls[0][1]({ preventDefault: vi.fn() });
    return {
      html, elements, fetchPage, dispatch,
      change(id: string, value: string) { elements[id].value = value; dispatch(id); },
      run(trailingSlash = false): Promise<void> {
        const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
        return new Script(script).runInNewContext({
          location: { pathname: pathname + (trailingSlash ? "/" : "") },
          document: {
            querySelector: (selector: string) => elements[selector.slice(1)],
            createElement: () => ({ value: "", textContent: "" }),
          },
          fetch: fetchPage,
        });
      },
    };
  }

  it("serves generated inline JavaScript that compiles without DOM or fetch", async () => {
    const service = new WebSessionInitService({ tokenFactory: () => "script-token" });
    const token = issueChallenge(service, getSessionStore());
    setWebSessionInitService(service);
    const response = await createApp(config()).request(`http://localhost/session-init/${token}`);

    expect(response.status).toBe(200);
    const html = await response.text();
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0][1].trim()).not.toBe("");
    expect(() => new Script(scripts[0][1])).not.toThrow();
  });

  it("serves an accessible standalone form with optional Task and no external assets or identities", async () => {
    const { html } = await pageRuntime();
    expect(html).toMatch(/<select id="team" required disabled>/);
    expect(html).toMatch(/<select id="agent" required disabled>/);
    expect(html).toMatch(/<select id="task" disabled>/);
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain("连接记忆会话");
    expect(html).toContain('for="team">团队');
    expect(html).toContain('for="agent">Agent');
    expect(html).toContain('class="optional">可选');
    expect(html).toContain('value="">不关联任务');
    expect(html).toContain('value="">请选择团队');
    expect(html).toContain('value="">请选择 Agent');
    expect(html).toContain('id="connect" type="submit" disabled>连接');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain("记忆会话已连接");
    expect(html).toContain("返回原客户端，重新发送刚才的请求。");
    expect(html).toContain("请选择当前会话要连接的团队、Agent 和可选任务。");
    expect(html).not.toMatch(/openclaw/i);
    expect(html).not.toMatch(/<(?:script|iframe)\b[^>]*src\s*=/i);
    for (const asset of html.matchAll(/<(?:link|img)\b[^>]*(?:src|href)="([^"]*)"/gi)) {
      expect(asset[1]).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
    }
    expect(html).not.toMatch(/https?:\/\/|url\s*\(|@import/i);
    for (const secret of ["secret-user-key", "conversation-a", "team-a", "agent-a", "task-a"]) {
      expect(html).not.toContain(secret);
    }
  });

  it("reuses the exact Panel PNG for the brand and favicon on normal and error pages", async () => {
    const { html } = await pageRuntime();
    const errorHtml = await (await createApp(config()).request("http://localhost/session-init/missing-token")).text();
    for (const page of [html, errorHtml]) {
      const logo = page.match(/<p class="brand"><img src="(data:image\/png;base64,([A-Za-z0-9+/=]+))"/);
      expect(logo).not.toBeNull();
      expect(page).toContain(`<link rel="icon" type="image/png" href="${logo![1]}">`);
      // 固定原版 PNG 的摘要，防止复用图标悄悄变成重绘图或远端资源。
      expect(createHash("sha256").update(Buffer.from(logo![2], "base64")).digest("hex"))
        .toBe("c3b0ebc4a6749d626817a116b0299bf81136f573a4731f6217de530a0e46d0f7");
    }
  });

  it("uses decorative inline status and dropdown icons without replacing native selects", async () => {
    const { html } = await pageRuntime();
    for (const name of ["loading", "success", "error", "warning"]) {
      expect(html).toContain(`class="status-icon ${name}-icon"`);
    }
    const dropdowns = [...html.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>(<svg class="dropdown-icon"[^>]*>)/g)];
    expect(dropdowns).toHaveLength(3);
    for (const [, svg] of dropdowns) {
      expect(svg).toContain('aria-hidden="true"');
      expect(svg).toContain('focusable="false"');
    }
    for (const [svg] of html.matchAll(/<svg\b[^>]*>/g)) {
      expect(svg).toContain('aria-hidden="true"');
      expect(svg).toContain('focusable="false"');
    }
  });

  it.each([false, true])("requires Team and Agent, resets dependent choices, and handles trailing slash=%s", async (trailingSlash) => {
    const page = await pageRuntime();
    const options = deferred<Response>();
    page.fetchPage.mockReturnValueOnce(options.promise);
    const loaded = page.run(trailingSlash);
    for (const id of ["team", "agent", "task", "connect"]) expect(page.elements[id].disabled).toBe(true);
    expect(page.elements["status-title"].textContent).toBe("正在加载会话资源...");
    expect(page.fetchPage).toHaveBeenCalledWith("/session-init/ui-token/options", expect.anything());
    options.resolve(await page.fetchPage("/session-init/ui-token/options"));
    await loaded;

    expect(page.elements.team.disabled).toBe(false);
    expect(page.elements.agent.disabled).toBe(true);
    expect(page.elements.connect.disabled).toBe(true);
    page.change("team", "team-a");
    expect(page.elements.agent.disabled).toBe(false);
    expect(page.elements.task.disabled).toBe(false);
    expect(page.elements.connect.disabled).toBe(true);
    page.change("agent", "agent-a");
    expect(page.elements.connect.disabled).toBe(false);
    page.change("agent", "");
    expect(page.elements.connect.disabled).toBe(true);
    page.change("agent", "agent-a");
    page.elements.task.value = "task-a";
    page.change("team", "team-b");
    expect(page.elements.agent.value).toBe("");
    expect(page.elements.task.value).toBe("");
    expect(page.elements.connect.disabled).toBe(true);
    page.change("agent", "agent-b");
    expect(page.elements.connect.disabled).toBe(false);
    page.change("team", "");
    expect(page.elements.agent.disabled).toBe(true);
    expect(page.elements.task.disabled).toBe(true);
    expect(page.elements.connect.disabled).toBe(true);
  });

  it("locks connecting controls, rejects duplicate submits, and allows retry before optional-Task success", async () => {
    const page = await pageRuntime();
    await page.run();
    await page.dispatch("form");
    expect(page.fetchPage).toHaveBeenCalledTimes(1);
    page.change("team", "team-a");
    page.change("agent", "agent-a");
    const completion = deferred<Response>();
    page.fetchPage.mockReturnValueOnce(completion.promise);
    const first = page.dispatch("form");
    for (const id of ["team", "agent", "task", "connect"]) expect(page.elements[id].disabled).toBe(true);
    expect(page.elements.connect.textContent).toBe("连接中...");
    await page.dispatch("form");
    expect(page.fetchPage).toHaveBeenCalledTimes(2);
    completion.resolve(new Response(JSON.stringify({ error: "invalid_selection", message: "Invalid selection" }), { status: 400 }));
    await first;
    expect(page.elements["status-title"].textContent).toBe("无法连接记忆会话");
    expect(page.elements["status-detail"].textContent).toBe("请选择有效的团队和 Agent；如需关联任务，请选择该团队下的任务。");
    expect(page.elements.connect.disabled).toBe(false);
    expect(page.elements.form.hidden).toBe(false);

    await page.dispatch("form");
    expect(page.fetchPage).toHaveBeenCalledTimes(3);
    const [path, request] = page.fetchPage.mock.calls[2];
    expect(path).toBe("/session-init/ui-token/complete");
    expect(JSON.parse(request!.body as string)).toEqual({ teamId: "team-a", agentId: "agent-a" });
    expect(page.elements.form.hidden).toBe(true);
    expect(page.elements["status-title"].textContent).toBe("记忆会话已连接");
    expect(page.elements["status-detail"].textContent).toBe("返回原客户端，重新发送刚才的请求。");
    expect(page.elements.connect.disabled).toBe(true);
    expect(bindingRepo.putCalls).toHaveLength(1);
    await page.dispatch("form");
    expect(page.fetchPage).toHaveBeenCalledTimes(3);
  });

  it("shows asset loading failures and permits reloading without injecting metadata HTML", async () => {
    const page = await pageRuntime();
    page.fetchPage.mockRejectedValueOnce(new Error("Network unavailable"));
    await page.run();
    expect(page.elements["status-title"].textContent).toBe("无法加载会话资源");
    expect(page.elements["status-detail"].textContent).toBe("加载失败，请重试。");
    expect(page.elements.retry.hidden).toBe(false);
    expect(page.elements.connect.disabled).toBe(true);
    const label = '<img src="https://untrusted.test/image" onerror="alert(1)">';
    page.fetchPage.mockResolvedValueOnce(new Response(JSON.stringify({
      teams: [{ team_id: "team-a", team_name: label, agents: [], tasks: [] }],
    })));
    await page.dispatch("retry");
    expect(page.elements.team.append).toHaveBeenCalledWith({ value: "team-a", textContent: label });
    expect(page.elements.team.disabled).toBe(false);
    expect(page.elements.retry.hidden).toBe(true);
    expect(page.elements.status.hidden).toBe(true);
  });

  it.each([
    ["invalid_token", "初始化链接无效", "请返回原客户端获取新的初始化链接。"],
    ["expired_token", "初始化链接已过期", "请返回原客户端获取新的初始化链接。"],
    ["already_initialized", "记忆会话已初始化", "返回原客户端，重新发送刚才的请求。"],
    ["completion_in_progress", "记忆会话正在连接", "请等待当前连接完成后重试。"],
    ["metadata_unavailable", "无法加载会话资源", "加载失败，请重试。"],
    ["unknown_error", "无法加载会话资源", "加载失败，请重试。"],
  ])("renders Chinese feedback for %s without exposing raw server errors", async (code, title, detail) => {
    const page = await pageRuntime();
    page.fetchPage.mockResolvedValueOnce(new Response(JSON.stringify({
      error: code, message: "Internal failure: secret-user-key team-a conversation-a",
    }), { status: 502 }));
    await page.run();
    expect(page.elements["status-title"].textContent).toBe(title);
    expect(page.elements["status-detail"].textContent).toBe(detail);
    expect(page.elements.retry.hidden).toBe(false);
    expect(page.elements.connect.disabled).toBe(true);
  });

  it.each([
    ["https://memory.example.com", "https://memory.example.com"],
    ["https://memory.example.com/proxy///", "https://memory.example.com/proxy"],
    [undefined, "http://backend-docker:8096"],
  ])("浏览器地址优先使用显式配置，否则保留直接访问 origin：%s", async (publicBase, expectedBase) => {
    const cfg = config();
    cfg.sessionInit.webPublicBaseUrl = publicBase;
    cfg.injection.externalGatewayUrl = "http://agent-tools:8096";
    const response = await createApp(cfg).request(
      "http://backend-docker:8096/openclaw/space-a/v1/chat/completions",
      chatRequest("conversation-public-url", {
        host: "untrusted.example",
        "x-forwarded-host": "untrusted.example",
        "x-forwarded-proto": "http",
      }),
    );
    const url = response.headers.get("x-memory-session-init-url");
    expect(url?.slice(0, url.lastIndexOf("/"))).toBe(`${expectedBase}/session-init`);
    expect(url?.split("/").pop()).toMatch(/^[A-Za-z0-9_-]+$/);
    const body = await response.text();
    expect(body).toContain(url!);
    expect(body).not.toContain("untrusted.example");
    expect(body).not.toContain("agent-tools");
    if (publicBase) expect(body).not.toContain("backend-docker");
  });

  it.each(["openclaw", "pi"])("%s uses the shared Web Init flow and recovers on retry", async (agentSource) => {
    if (agentSource === "pi") {
      // 仅在测试中为既有身份路由开启资格，生产环境仍不为 Pi 启用 Web Init。
      vi.spyOn(agentAdapters, "supportsWebSessionInit").mockImplementation((source) => source === agentSource);
    }
    const app = createApp(config());
    const first = await app.request(
      `http://localhost/${agentSource}/space-a/v1/chat/completions`,
      chatRequest("conversation-web", { authorization: "Bearer secret-user-key" }),
    );
    const initUrl = first.headers.get("x-memory-session-init-url");

    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(initUrl).toMatch(/^http:\/\/localhost\/session-init\/[A-Za-z0-9_-]+$/);
    const setupPrompt = await first.text();
    expect(setupPrompt).toContain(initUrl!);
    expect(setupPrompt).toContain("需要完成记忆会话初始化。");
    expect(setupPrompt).toContain("请打开以下链接，选择团队、Agent 和可选任务：");
    expect(setupPrompt).toContain("连接完成后，请重新发送刚才的请求。");
    expect(getSessionStore().get(`${agentSource}:conversation-web`)).toBeUndefined();

    const page = await app.request(initUrl!);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("连接记忆会话");
    expect(html).not.toContain("secret-user-key");
    expect(html).not.toContain("conversation-web");
    expect(html).not.toMatch(/openclaw|当前 pi 会话/i);

    const options = await app.request(`${initUrl}/options`);
    expect(options.status).toBe(200);
    const optionsBody = await options.json();
    expect(optionsBody.teams).toEqual(expect.arrayContaining([
      expect.objectContaining({
        team_id: "team-a",
        agents: expect.arrayContaining([expect.objectContaining({ agent_id: "agent-a" })]),
      }),
    ]));
    expect(JSON.stringify(optionsBody)).not.toContain("secret-user-key");
    expect(JSON.stringify(optionsBody)).not.toContain("conversation-web");

    const completion = await app.request(`${initUrl}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamId: "team-a", agentId: "agent-a", taskId: "task-a" }),
    });
    expect(completion.status).toBe(200);
    expect(getSessionStore().get(`${agentSource}:conversation-web`)?.status).toBe("initialized");
    expect(bindingRepo.values.get("space-a:conversation-web")).toMatchObject({
      outcome: "initialized",
      teamId: "team-a",
      agentId: "agent-a",
      taskId: "task-a",
      agentSource,
    });

    for (const recoverySource of ["l1", "l2a", "l2b"]) {
      // L1 仅用于兜底；可用的 L2a 仍是权威来源。
      if (recoverySource === "l1") vi.spyOn(sessionRepo, "getBySessionId").mockResolvedValueOnce(null);
      if (recoverySource !== "l1") {
        __resetSessionStoreForTests();
        if (recoverySource === "l2b") setSessionRepo(new MemorySessionRepo());
        getSessionStore().setBindingRepo(bindingRepo);
      }
      const recover = vi.spyOn(getSessionStore(), "getOrRecover");
      const retry = await app.request(
        `http://localhost/${agentSource}/space-a/v1/chat/completions`,
        chatRequest("conversation-web", { authorization: "Bearer secret-user-key" }),
      );
      expect((await recover.mock.results[0].value)?.__recoverySource).toBe(recoverySource);
      expect(retry.headers.get("x-memory-session-init-url")).toBeNull();
      expect(await retry.json()).toMatchObject({ id: "upstream-response" });
      const upstreamCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("http://upstream.test/"));
      const forwarded = JSON.parse(upstreamCalls.at(-1)![1]!.body as string);
      expect(forwarded.messages).toContainEqual({ role: "user", content: "Hello" });
      expect(JSON.stringify(forwarded.messages)).toContain("Be precise.");
      recover.mockRestore();
    }
  });

  it.each([undefined, "task-a", "stale-task"])("preserves static Team/Agent registration with Task=%s", async (taskId) => {
    const app = createApp(config());
    const response = await app.request(
      "http://localhost/openclaw/space-a/v1/chat/completions",
      chatRequest("conversation-static", {
        "x-team-id": "team-a",
        "x-agent-id": "agent-a",
        ...(taskId ? { "x-task-id": taskId } : {}),
      }),
    );

    expect(response.headers.get("x-memory-session-init-url")).toBeNull();
    expect(getSessionStore().get("openclaw:conversation-static")?.sessionInfo).toMatchObject({
      team_id: "team-a",
      agent_id: "agent-a",
      task_id: taskId === "task-a" ? taskId : undefined,
    });
    expect(bindingRepo.values.get("space-a:conversation-static")).toMatchObject({
      outcome: "initialized",
      teamId: "team-a",
      agentId: "agent-a",
    });
  });

  it.each([undefined, "https://public.example.com/proxy/"])("SSE challenge 的 header 与正文地址一致且不转发上游：%s", async (publicBase) => {
    const cfg = config();
    cfg.sessionInit.webPublicBaseUrl = publicBase;
    const request = chatRequest("stream-session");
    request.body = JSON.stringify({ ...JSON.parse(request.body as string), stream: true });
    const response = await createApp(cfg).request(
      "http://localhost/openclaw/space-a/v1/chat/completions", request,
    );
    const url = response.headers.get("x-memory-session-init-url");
    expect(url).toMatch(/\/session-init\//);
    if (publicBase) expect(url).toMatch(/^https:\/\/public\.example\.com\/proxy\/session-init\//);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const stream = await response.text();
    expect(stream).toContain(url!);
    expect(stream).toContain("data: [DONE]");
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("http://upstream.test/")))
      .toHaveLength(0);
  });

  it("rejects OpenClaw session-reset without clearing binding or issuing a challenge", async () => {
    const cfg = config();
    cfg.memCommand!.enabled = true;
    const service = new WebSessionInitService({ tokenFactory: () => "reset-test-token" });
    const token = issueChallenge(service, getSessionStore(), metadata, "reset-session");
    expect(await service.complete(token, { teamId: "team-a", agentId: "agent-a" }))
      .toEqual({ ok: true, value: null });
    const issue = vi.spyOn(service, "issue");
    const remove = vi.spyOn(bindingRepo, "deleteBinding");
    setWebSessionInitService(service);
    const request = chatRequest("reset-session");
    request.body = JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "mem:session-reset" }] });
    const response = await createApp(cfg).request("http://localhost/openclaw/space-a/v1/chat/completions", request);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("不会清除现有 session binding");
    expect(response.headers.get("x-memory-session-init-url")).toBeNull();
    expect(issue).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(bindingRepo.values.get("space-a:reset-session")).toMatchObject({ teamId: "team-a", agentId: "agent-a" });
    expect(bindingRepo.putCalls).toHaveLength(1);
    expect(getSessionStore().get("openclaw:reset-session")?.status).toBe("initialized");
  });

  it("rejects an unknown route token", async () => {
    const app = createApp(config());
    const response = await app.request("http://localhost/session-init/unknown/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamId: "team-a", agentId: "agent-a" }),
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: "invalid_token" });
  });

  it("keeps arbitrary client identity out of HTML, scripts, and public challenge data", async () => {
    const source = '</script><img src=x onerror="alert(1)">';
    const service = new WebSessionInitService({ tokenFactory: () => "generic-token" });
    const token = issueChallenge(service, getSessionStore(), metadata, "generic-session", source);
    setWebSessionInitService(service);
    const app = createApp(config());
    const baseUrl = `http://localhost/session-init/${token}`;
    const page = await app.request(`${baseUrl}?client=${encodeURIComponent(source)}`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).not.toContain(source);
    expect(html).not.toContain("generic-session");
    expect(html).not.toContain("secret-user-key");
    expect(html).not.toMatch(/openclaw/i);
    expect([...html.matchAll(/<script>/g)]).toHaveLength(1);
    const options = await (await app.request(`${baseUrl}/options`)).json();
    expect(Object.keys(options).sort()).toEqual(["expiresAt", "teams"]);
    expect(JSON.stringify(options)).not.toContain(source);

    const complete = await app.request(`${baseUrl}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamId: "team-a", agentId: "agent-a" }),
    });
    expect(await complete.json()).toEqual({ connected: true });
    expect(bindingRepo.values.get("space-a:generic-session")).toMatchObject({ agentSource: source });
    expect(service.inspect(token)).toMatchObject({ ok: false, code: "invalid_token" });
  });

  it.each(["hermes", "codebuddy", "pi", "unknown-client"])("does not enable Web Init for %s", async (agentSource) => {
    expect(agentAdapters.supportsWebSessionInit(agentSource)).toBe(false);
    const service = new WebSessionInitService();
    const issue = vi.spyOn(service, "issue");
    setWebSessionInitService(service);
    const response = await createApp(config()).request(
      `http://localhost/${agentSource}/space-a/v1/chat/completions`,
      chatRequest("openclaw-forged-prefix", { "x-agent-source": "openclaw" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-memory-session-init-url")).toBeNull();
    expect(issue).not.toHaveBeenCalled();
  });

  it.each(["no-conversation", "no-binding-repo", "disabled"])("keeps the existing gate for %s", async (gate) => {
    const cfg = config();
    if (gate === "disabled") cfg.sessionInit.enabled = false;
    const service = new WebSessionInitService();
    const issue = vi.spyOn(service, "issue");
    setWebSessionInitService(service);
    const request = chatRequest("gated-session");
    if (gate === "no-conversation") delete (request.headers as Record<string, string>)["x-conversation-id"];
    const app = createApp(cfg);
    // 模拟启动后持久化不可用；正常启动会安装文件型 fallback。
    if (gate === "no-binding-repo") vi.spyOn(getSessionStore(), "getBindingRepo").mockReturnValue(undefined);
    const response = await app.request("http://localhost/openclaw/space-a/v1/chat/completions", request);
    expect(response.headers.get("x-memory-session-init-url")).toBeNull();
    expect(issue).not.toHaveBeenCalled();
  });

  it.each(["invalid-preset", "pending-form"])("falls back to Web Init for %s and preserves mismatch configuration", async (scenario) => {
    const cfg = config();
    cfg.sessionInit.headerAutoSelect!.onMismatch = "bypass";
    if (scenario === "pending-form") {
      await getSessionStore().set("openclaw:fallback-session", {
        status: "pending_asset_confirm", keyId: "fallback-session", startedAt: Date.now(),
        attemptCount: 1, userId: "user-a",
      });
    }
    const response = await createApp(cfg).request(
      "http://localhost/openclaw/space-a/v1/chat/completions",
      chatRequest("fallback-session", {
        "x-team-id": "team-a",
        "x-agent-id": scenario === "invalid-preset" ? "missing-agent" : "agent-a",
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-memory-session-init-url")).toMatch(/\/session-init\//);
    expect(getSessionStore().get("openclaw:fallback-session")?.status).not.toBe("initialized");
    expect(bindingRepo.putCalls).toHaveLength(0);
    expect(cfg.sessionInit.headerAutoSelect!.onMismatch).toBe("bypass");
  });

  it.each([
    ["null", "null"],
    ["string", JSON.stringify("selection")],
    ["array", JSON.stringify([])],
    ["number", JSON.stringify(123)],
  ])("rejects JSON primitive %s as invalid_selection without a 500", async (_name, body) => {
    const route = routeChallenge();
    const complete = vi.spyOn(route.service, "complete");
    const response = await route.complete(body);

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: "invalid_selection" });
    expect(complete).not.toHaveBeenCalled();
    expect(bindingRepo.putCalls).toHaveLength(0);
  });

  it.each([401, 500])("does not expose MetadataClient credentials or response bodies on HTTP %i", async (status) => {
    const userKey = "sk-short-secret";
    const serviceToken = "service-token-secret";
    const responseSecret = "kernel-response-secret";
    const errorBody = JSON.stringify({ error: responseSecret, user_key: userKey });
    const logs: string[] = [];
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
    }

    const client = new MetadataClient(
      { endpoint: "http://kernel.test", serviceToken, timeoutMs: 1_500 },
      "space-a",
      userKey,
      vi.fn(async () => new Response(
        errorBody,
        { status, headers: { "content-type": "application/json" } },
      )),
    );
    const route = routeChallenge(client);
    const response = status === 401
      ? await route.app.request(`http://localhost${route.pathname}/options`)
      : await route.complete();
    const responseText = await response.text();
    const captured = logs.join("\n");

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(responseText).not.toContain(userKey);
    expect(responseText).not.toContain(responseSecret);
    expect(responseText).toContain("metadata_unavailable");
    expect(captured).not.toContain(userKey);
    expect(captured).not.toContain("sk-short");
    expect(captured).not.toContain(serviceToken);
    expect(captured).not.toContain(responseSecret);
    expect(captured).not.toContain("userKey.prefix");
    expect(captured).not.toContain("body.head");
    expect(captured).toContain("path=/v3/meta/team/list");
    expect(captured).toContain(`status=${status}`);
    expect(captured).toContain(`userKey.len=${userKey.length}`);
    expect(captured).toContain(`serviceToken.len=${serviceToken.length}`);
    expect(captured).toContain(`body.len=${errorBody.length}`);
  });

  it.each(["envelope", "network"])("does not expose %s exceptions through either Web Init API", async (failure) => {
    const secret = "sk-mem-error-boundary-secret";
    let fail = true;
    const client = new MetadataClient(
      { endpoint: "http://kernel.test", serviceToken: secret, timeoutMs: 1_500 },
      "space-a",
      secret,
      vi.fn(async () => {
        if (failure === "network") throw new Error(`Network error: ${secret}`);
        return new Response(JSON.stringify({ code: 500, message: `Rejected: ${secret}` }));
      }),
    );
    const service = new WebSessionInitService({ tokenFactory: () => "error-boundary-token" });
    const token = issueChallenge(service, getSessionStore(), {
      ...metadata,
      listTeams: (userId: string) => fail ? client.listTeams(userId) : metadata.listTeams(userId),
    });
    setWebSessionInitService(service);
    const app = createApp(config());
    const baseUrl = `http://localhost/session-init/${token}`;
    const selection = {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamId: "team-a", agentId: "agent-a" }),
    };
    for (const response of [
      await app.request(`${baseUrl}/options`),
      await app.request(`${baseUrl}/complete`, selection),
    ]) {
      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.text();
      expect(body).toContain("metadata_unavailable");
      expect(body).not.toContain(secret);
      expect(body).not.toContain("Rejected:");
      expect(body).not.toContain("Network error:");
    }
    expect(bindingRepo.putCalls).toHaveLength(0);
    fail = false;
    expect((await app.request(`${baseUrl}/complete`, selection)).status).toBe(200);
    expect(bindingRepo.putCalls).toHaveLength(1);
  });

  it("returns HTTP 410 and writes no binding when completion expires during metadata wait", async () => {
    let now = 100;
    const teams = deferred<Awaited<ReturnType<typeof metadata.listTeams>>>();
    const started = deferred<void>();
    const service = new WebSessionInitService({
      ttlMs: 50,
      now: () => now,
      tokenFactory: () => "route-expires-during-metadata",
    });
    const token = issueChallenge(service, getSessionStore(), {
      ...metadata,
      listTeams() {
        started.resolve(undefined);
        return teams.promise;
      },
    }, "route-expires-during-metadata");
    setWebSessionInitService(service);
    const app = createApp(config());

    // 等 metadata 已开始后再跨 TTL，避免只覆盖请求进入 service 前已过期的普通 410 分支。
    const pending = app.request(`http://localhost/session-init/${token}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamId: "team-a", agentId: "agent-a" }),
    });
    await started.promise;
    now = 151;
    teams.resolve(await metadata.listTeams("user-a"));
    const response = await pending;

    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: "expired_token" });
    expect(getSessionStore().get("openclaw:route-expires-during-metadata")).toBeUndefined();
    expect(bindingRepo.putCalls).toHaveLength(0);
  });

  it("sets no-store on page success, invalid-token, and expired-token responses", async () => {
    let now = 100;
    let tokenNumber = 0;
    const service = new WebSessionInitService({
      ttlMs: 50,
      now: () => now,
      tokenFactory: () => `page-token-${++tokenNumber}`,
    });
    const validToken = issueChallenge(service, getSessionStore(), metadata, "page-valid");
    const expiredToken = issueChallenge(service, getSessionStore(), metadata, "page-expired");
    setWebSessionInitService(service);
    const app = createApp(config());

    const success = await app.request(`http://localhost/session-init/${validToken}`);
    const invalid = await app.request("http://localhost/session-init/missing-token");
    now = 151;
    const expired = await app.request(`http://localhost/session-init/${expiredToken}`);

    expect(success.status).toBe(200);
    expect(invalid.status).toBe(404);
    expect(expired.status).toBe(410);
    for (const response of [success, invalid, expired]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toBe(
        "default-src 'self'; img-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
    }
    for (const [response, title] of [
      [invalid, "初始化链接无效"],
      [expired, "初始化链接已过期"],
    ] as const) {
      const html = await response.text();
      expect(html).toContain('<html lang="zh-CN">');
      expect(html).toContain(`<h1>${title}</h1>`);
      expect(html).toContain("请返回原客户端获取新的初始化链接。");
      expect(html).not.toMatch(/openclaw/i);
      expect(html).not.toContain("secret-user-key");
    }
  });

  it("sets no-store on options success and all options error responses", async () => {
    let now = 100;
    let tokenNumber = 0;
    const service = new WebSessionInitService({
      ttlMs: 50,
      now: () => now,
      tokenFactory: () => `options-token-${++tokenNumber}`,
    });
    const validToken = issueChallenge(service, getSessionStore(), metadata, "options-valid");
    const expiredToken = issueChallenge(service, getSessionStore(), metadata, "options-expired");
    setWebSessionInitService(service);
    const app = createApp(config());

    const success = await app.request(`http://localhost/session-init/${validToken}/options`);
    const invalid = await app.request("http://localhost/session-init/missing-token/options");
    now = 151;
    const expired = await app.request(`http://localhost/session-init/${expiredToken}/options`);

    // metadata unavailable 在 token 仍有效时产生，避免把 502 与 invalid/expired 混淆。
    const unavailableService = new WebSessionInitService({ tokenFactory: () => "options-unavailable" });
    const unavailableToken = issueChallenge(unavailableService, getSessionStore(), {
      ...metadata,
      async listTeams() {
        throw new Error("metadata offline");
      },
    });
    setWebSessionInitService(unavailableService);
    const unavailable = await app.request(`http://localhost/session-init/${unavailableToken}/options`);

    expect(success.status).toBe(200);
    expect(invalid.status).toBe(404);
    expect(expired.status).toBe(410);
    expect(unavailable.status).toBe(502);
    for (const response of [success, invalid, expired, unavailable]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it.each([
    { outcome: "success", status: 200 },
    { outcome: "invalid_token", status: 404 },
    { outcome: "expired_token", status: 410 },
    { outcome: "invalid_json", status: 400, body: "{" },
    { outcome: "invalid_team", status: 400, body: JSON.stringify({ teamId: "team-missing", agentId: "agent-a" }) },
    { outcome: "invalid_agent", status: 400, body: JSON.stringify({ teamId: "team-a", agentId: "agent-missing" }) },
    { outcome: "invalid_task", status: 400, body: JSON.stringify({ teamId: "team-a", agentId: "agent-a", taskId: "task-missing" }) },
    { outcome: "metadata_unavailable", status: 502 },
  ])("complete 的 $outcome 响应保持 HTTP $status 和 no-store", async ({ outcome, status, body }) => {
    let now = 100;
    const route = routeChallenge({
      ...metadata,
      async listTeams(userId: string) {
        if (outcome === "metadata_unavailable") throw new Error("metadata offline");
        return metadata.listTeams(userId);
      },
    }, { ttlMs: 50, now: () => now });
    if (outcome === "invalid_token") route.service.reset();
    if (outcome === "expired_token") now = 151;

    const response = await route.complete(body);
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(bindingRepo.putCalls).toHaveLength(status === 200 ? 1 : 0);
  });

  it("并发 complete 返回 409 且两个响应都禁止缓存，首次提交仍可完成", async () => {
    // HTTP 层同样保持两个 POST 并发，不能退化为顺序 duplicate 测试。
    const teams = deferred<Awaited<ReturnType<typeof metadata.listTeams>>>();
    const started = deferred<void>();
    const route = routeChallenge({
      ...metadata,
      listTeams() {
        started.resolve(undefined);
        return teams.promise;
      },
    });
    const firstCompletion = route.complete();
    await started.promise;
    const conflict = await route.complete();
    teams.resolve(await metadata.listTeams("user-a"));
    const completedAfterConflict = await firstCompletion;

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "completion_in_progress" });
    expect(completedAfterConflict.status).toBe(200);
    expect(bindingRepo.putCalls).toHaveLength(1);
    for (const response of [conflict, completedAfterConflict]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});
