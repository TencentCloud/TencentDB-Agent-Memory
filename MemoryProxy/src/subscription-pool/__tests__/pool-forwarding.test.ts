/**
 * Codex requests of an agent in a subscription pool group, against a mock ChatGPT backend and a
 * mock Core. Covers account injection, switching on 429, token refresh on 401, fallbacks, and
 * that no access token reaches logs or the client.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __primeCacheForTests, type InstanceUpstreamRow } from "../../instance-upstream-cache.js";
import { __primeAccountCacheForTests } from "../account-cache.js";
import { CORE_URL, installFetch, jsonResponse, makeApp, makeConfig, resetPoolState, type RecordedCall } from "./test-harness.js";
import type { PoolAccount, PoolQuotaWindow } from "../types.js";

const SPACE = "sp-pool";
const CHATGPT = "https://chatgpt.com/backend-api/codex";
const NOW = Date.now();
const HOUR = 3_600_000;

const defaultRow: InstanceUpstreamRow = {
  group_id: "d", group_type: "default", name: "default", agents: ["claude-code"], enabled: true,
  mode: "official", base_url: "", api_key: "", model_id: "",
};
const poolRow: InstanceUpstreamRow = {
  group_id: "pool-codex", group_type: "custom", name: "Codex pool", agents: ["codex"], enabled: true,
  mode: "subscription_pool", base_url: "", api_key: "", model_id: "",
};

function win(name: string, used: number, resetsIn: number): PoolQuotaWindow {
  return { name, model_scope: null, used_pct: used, resets_at: NOW + resetsIn, observed_at: NOW, source: "usage_api" };
}

function acct(id: string, partial: Partial<PoolAccount> = {}): PoolAccount {
  return {
    account_id: id, group_id: "pool-codex", provider: "codex", provider_account_id: `chatgpt-${id}`,
    status: "active", enabled: true, access_token: `secret-token-${id}`, token_expires_at: NOW + 5 * HOUR,
    usage: { windows: [win("primary_window", 10, HOUR), win("secondary_window", 20, 24 * HOUR)] },
    exhausted_until: null, ...partial,
  };
}

function prime(accounts: PoolAccount[], rows: InstanceUpstreamRow[] = [defaultRow, poolRow]): void {
  __primeCacheForTests(SPACE, rows);
  __primeAccountCacheForTests(SPACE, { thresholdPct: 95, accounts });
}

const sse = (headers: Record<string, string> = {}): Response =>
  new Response("data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n", {
    status: 200, headers: { "content-type": "text/event-stream", ...headers },
  });

const limit429 = (resetsInSec = 600): Response =>
  jsonResponse({ error: { type: "usage_limit_reached", resets_at: Math.floor(Date.now() / 1000) + resetsInSec } }, 429);

function post(app: ReturnType<typeof makeApp>, path: string, headers: Record<string, string>, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const turn = (sessionId = "sess-1") => ({
  path: `/codex/${SPACE}/v1/responses`,
  headers: { "x-tdai-user-key": "sk-mem-user", authorization: "Bearer chatgpt-own-token", "chatgpt-account-id": "own-acct", "session-id": sessionId },
  body: { model: "gpt-5-codex", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], stream: true },
});

const accountOf = (call: RecordedCall): string => call.headers["chatgpt-account-id"] ?? "";

describe("codex pool forwarding", () => {
  let logs: string[];
  beforeEach(() => {
    resetPoolState();
    logs = [];
    for (const method of ["log", "warn", "error", "info", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    }
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("sends the chosen account's token and chatgpt-account-id to the ChatGPT backend and sets store:false", async () => {
    prime([acct("a"), acct("b")]);
    const { upstreamCalls } = installFetch(() => sse());
    const t = turn();
    const res = await post(makeApp(makeConfig()), t.path, { ...t.headers, "x-custom-client": "keep-me", originator: "codex_cli_rs" }, t.body);
    await res.text();
    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    const call = upstreamCalls[0]!;
    expect(call.url).toBe(`${CHATGPT}/responses`);
    expect(call.headers["authorization"]).toBe("Bearer secret-token-a");
    expect(accountOf(call)).toBe("chatgpt-a");
    expect(call.headers["x-tdai-user-key"]).toBeUndefined();
    expect(call.headers["x-custom-client"]).toBe("keep-me");
    expect(call.headers["originator"]).toBe("codex_cli_rs");
    const sent = JSON.parse(call.body);
    expect(sent.store).toBe(false);
    expect(sent.model).toBe("gpt-5-codex");
  });

  it("keeps a store value the client already set", async () => {
    prime([acct("a")]);
    const { upstreamCalls } = installFetch(() => sse());
    const t = turn();
    const res = await post(makeApp(makeConfig()), t.path, t.headers, { ...t.body, store: true });
    await res.text();
    expect(JSON.parse(upstreamCalls[0]!.body).store).toBe(true);
  });

  it("does not report pool traffic as TokenHub credit and adds no credit error header", async () => {
    prime([acct("a")]);
    const { coreCalls } = installFetch(() => sse());
    const t = turn();
    const res = await post(makeApp(makeConfig()), t.path, t.headers, t.body);
    await res.text();
    expect(res.headers.get("x-credit-report-error")).toBeNull();
    expect(coreCalls.filter((c) => c.url.includes("credit"))).toHaveLength(0);
  });

  it("keeps a session on its account and gives the next session the next account", async () => {
    prime([acct("a"), acct("b")]);
    const { upstreamCalls } = installFetch(() => sse());
    const app = makeApp(makeConfig());
    for (const session of ["s1", "s1", "s2", "s1", "s2"]) {
      const t = turn(session);
      await (await post(app, t.path, t.headers, t.body)).text();
    }
    expect(upstreamCalls.map(accountOf)).toEqual(["chatgpt-a", "chatgpt-a", "chatgpt-b", "chatgpt-a", "chatgpt-b"]);
  });

  it("switches to the other account when the first answers 429, within the same request", async () => {
    prime([acct("a"), acct("b")]);
    const { upstreamCalls, coreCalls } = installFetch((call) => (accountOf(call) === "chatgpt-a" ? limit429(600) : sse()));
    const app = makeApp(makeConfig());
    const t = turn("s1");
    const res = await post(app, t.path, t.headers, t.body);
    await res.text();
    expect(res.status).toBe(200);
    expect(upstreamCalls.map(accountOf)).toEqual(["chatgpt-a", "chatgpt-b"]);
    expect(upstreamCalls[1]!.headers["authorization"]).toBe("Bearer secret-token-b");

    // The session now sits on account b, and account a is skipped for other sessions.
    const next = turn("s1");
    await (await post(app, next.path, next.headers, next.body)).text();
    const other = turn("s-other");
    await (await post(app, other.path, other.headers, other.body)).text();
    expect(upstreamCalls.slice(2).map(accountOf)).toEqual(["chatgpt-b", "chatgpt-b"]);

    // The 429 reaches Core with its retry_after.
    await vi.waitFor(() => {
      const reports = coreCalls.filter((c) => c.url.endsWith("/subscription-pool/report")).map((c) => JSON.parse(c.body));
      expect(reports.some((r) => r.account_id === "a" && r.status_code === 429 && r.retry_after > 0 && r.retry_after <= 600)).toBe(true);
    });
  });

  it("selects account a again for a new session once its reset time has passed", async () => {
    prime([acct("a"), acct("b")]);
    let accountAIsLimited = true;
    const { upstreamCalls } = installFetch((call) => (accountOf(call) === "chatgpt-a" && accountAIsLimited ? limit429(600) : sse()));
    const app = makeApp(makeConfig());
    const first = turn("s1");
    await (await post(app, first.path, first.headers, first.body)).text();
    expect(upstreamCalls.map(accountOf)).toEqual(["chatgpt-a", "chatgpt-b"]);

    // While account a is exhausted, new sessions all go to b.
    for (const session of ["s2", "s3"]) {
      const t = turn(session);
      await (await post(app, t.path, t.headers, t.body)).text();
    }
    expect(upstreamCalls.slice(2).map(accountOf)).toEqual(["chatgpt-b", "chatgpt-b"]);

    // Past the reset time account a is selectable again, with no call to Core in between.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 11 * 60_000);
      __primeCacheForTests(SPACE, [defaultRow, poolRow]);
      __primeAccountCacheForTests(SPACE, { thresholdPct: 95, accounts: [acct("a", { status: "exhausted", exhausted_until: Date.now() - 1000 }), acct("b")] });
      accountAIsLimited = false;
      upstreamCalls.length = 0;
      for (const session of ["s4", "s5"]) {
        const t = turn(session);
        await (await post(app, t.path, t.headers, t.body)).text();
      }
      expect(upstreamCalls.map(accountOf).sort()).toEqual(["chatgpt-a", "chatgpt-b"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes the token once on 401 and retries the same account", async () => {
    prime([acct("a")]);
    const { upstreamCalls, coreCalls } = installFetch(
      (call) => (call.headers["authorization"] === "Bearer secret-token-a" ? new Response("{}", { status: 401 }) : sse()),
      (call) => {
        if (call.url.endsWith("/refresh")) {
          return jsonResponse({ code: 0, data: { account_id: "a", access_token: "fresh-token-a", provider_account_id: "chatgpt-a", token_expires_at: NOW + 9 * HOUR } });
        }
        return jsonResponse({ code: 0, data: {} });
      },
    );
    const t = turn("s1");
    const res = await post(makeApp(makeConfig()), t.path, t.headers, t.body);
    await res.text();
    expect(res.status).toBe(200);
    expect(upstreamCalls.map((c) => c.headers["authorization"])).toEqual(["Bearer secret-token-a", "Bearer fresh-token-a"]);
    const refresh = coreCalls.find((c) => c.url.endsWith("/refresh"))!;
    expect(JSON.parse(refresh.body)).toEqual({ account_id: "a", held_expires_at: NOW + 5 * HOUR });
  });

  it("moves to another account when the token refresh fails", async () => {
    prime([acct("a"), acct("b")]);
    const { upstreamCalls } = installFetch(
      (call) => (accountOf(call) === "chatgpt-a" ? new Response("{}", { status: 401 }) : sse()),
      (call) => (call.url.endsWith("/refresh")
        ? jsonResponse({ code: 502, message: "token_refresh_failed: refused" }, 502)
        : jsonResponse({ code: 0, data: {} })),
    );
    const t = turn("s1");
    const res = await post(makeApp(makeConfig()), t.path, t.headers, t.body);
    await res.text();
    expect(res.status).toBe(200);
    expect(upstreamCalls.map(accountOf)).toEqual(["chatgpt-a", "chatgpt-b"]);
  });

  it("falls back to the client's own login when every account is out of quota and the user key header was used", async () => {
    prime([acct("a"), acct("b")]);
    const { upstreamCalls } = installFetch((call) => (call.headers["authorization"] === "Bearer chatgpt-own-token" ? sse() : limit429(600)));
    const t = turn("s1");
    const res = await post(makeApp(makeConfig()), t.path, t.headers, t.body);
    await res.text();
    expect(res.status).toBe(200);
    const last = upstreamCalls[upstreamCalls.length - 1]!;
    expect(last.url).toBe(`${CHATGPT}/responses`);
    expect(last.headers["authorization"]).toBe("Bearer chatgpt-own-token");
    expect(accountOf(last)).toBe("own-acct");
    expect(last.headers["x-tdai-user-key"]).toBeUndefined();
  });

  it("answers 429 with the earliest reset when every account is out of quota and there is no client login", async () => {
    prime([
      acct("a", { status: "exhausted", exhausted_until: NOW + 2 * HOUR }),
      acct("b", { status: "exhausted", exhausted_until: NOW + HOUR }),
    ]);
    const { upstreamCalls } = installFetch(() => sse());
    const t = turn("s1");
    const headers = { authorization: "Bearer sk-mem-user", "session-id": "s1" };
    const res = await post(makeApp(makeConfig()), t.path, headers, t.body);
    expect(res.status).toBe(429);
    expect(upstreamCalls).toHaveLength(0);
    expect(res.headers.get("x-tdai-pool-status")).toBe("exhausted");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(3500);
    expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(3600);
    expect(Number(res.headers.get("x-tdai-pool-earliest-reset"))).toBe(Math.ceil((NOW + HOUR) / 1000));
  });

  it("answers 503, not an exhausted 429, when Core cannot list the accounts", async () => {
    __primeCacheForTests(SPACE, [defaultRow, poolRow]);
    const { upstreamCalls } = installFetch(() => sse(), () => { throw new Error("core down"); });
    const t = turn("s1");
    const headers = { authorization: "Bearer sk-mem-user", "session-id": "s1" };
    const res = await post(makeApp(makeConfig()), t.path, headers, t.body);
    expect(res.status).toBe(503);
    expect(upstreamCalls).toHaveLength(0);
    expect(res.headers.get("x-tdai-pool-status")).toBe("unavailable");
    expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(60);
  });

  it.each(["", "   "])("never forwards the proxy user key as a client login when x-tdai-user-key is %j", async (headerValue) => {
    prime([acct("a", { status: "exhausted", exhausted_until: NOW + HOUR })]);
    const { upstreamCalls } = installFetch(() => sse());
    const t = turn("s1");
    const headers = { "x-tdai-user-key": headerValue, authorization: "Bearer sk-mem-user", "session-id": "s1" };
    const res = await post(makeApp(makeConfig()), t.path, headers, t.body);
    expect(res.status).toBe(429);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("does not use the client login fallback when the bearer is the user key", async () => {
    prime([acct("a", { status: "exhausted", exhausted_until: NOW + HOUR })]);
    const { upstreamCalls } = installFetch(() => sse());
    const t = turn("s1");
    const headers = { "x-tdai-user-key": "sk-mem-user", authorization: "Bearer sk-mem-user", "session-id": "s1" };
    const res = await post(makeApp(makeConfig()), t.path, headers, t.body);
    expect(res.status).toBe(429);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("answers 503 without forwarding when Core is down and x-tdai-user-key is empty", async () => {
    __primeCacheForTests(SPACE, [defaultRow, poolRow]);
    const { upstreamCalls } = installFetch(() => sse(), () => { throw new Error("core down"); });
    const t = turn("s1");
    const headers = { "x-tdai-user-key": "", authorization: "Bearer sk-mem-user", "session-id": "s1" };
    const res = await post(makeApp(makeConfig()), t.path, headers, t.body);
    expect(res.status).toBe(503);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("forwards the client's model name unchanged even when a main model is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "main-model-"));
    const file = join(dir, "main-model.json");
    writeFileSync(file, JSON.stringify({ model: "claude-opus-5" }));
    vi.stubEnv("TDAI_PROXY_MAIN_MODEL_FILE", file);
    try {
      prime([acct("a")]);
      const { upstreamCalls } = installFetch(() => sse());
      const t = turn("s1");
      const res = await post(makeApp(makeConfig()), t.path, t.headers, t.body);
      await res.text();
      expect(res.status).toBe(200);
      expect(JSON.parse(upstreamCalls[0]!.body).model).toBe(t.body.model);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the lowest-usage account when every account is above the threshold but none is exhausted", async () => {
    prime([
      acct("a", { usage: { windows: [win("primary_window", 99, HOUR)] } }),
      acct("b", { usage: { windows: [win("primary_window", 96, HOUR)] } }),
    ]);
    const { upstreamCalls } = installFetch(() => sse());
    const t = turn("s1");
    await (await post(makeApp(makeConfig()), t.path, t.headers, t.body)).text();
    expect(accountOf(upstreamCalls[0]!)).toBe("chatgpt-b");
  });

  it("reads quota headers into a report to Core with usage API window names", async () => {
    prime([acct("a")]);
    const reset = Math.floor(Date.now() / 1000) + 1800;
    const { coreCalls } = installFetch(() => sse({
      "x-codex-primary-used-percent": "55", "x-codex-primary-reset-at": String(reset),
      "x-codex-secondary-primary-used-percent": "30", "x-codex-secondary-primary-reset-at": String(reset + 86400),
    }));
    const t = turn("s1");
    await (await post(makeApp(makeConfig()), t.path, t.headers, t.body)).text();
    await vi.waitFor(() => {
      const reports = coreCalls.filter((c) => c.url.endsWith("/subscription-pool/report")).map((c) => JSON.parse(c.body));
      const withWindows = reports.find((r) => r.windows);
      expect(withWindows).toBeDefined();
      expect(withWindows.account_id).toBe("a");
      expect(withWindows.windows.map((w: PoolQuotaWindow) => [w.name, w.used_pct, w.resets_at])).toEqual([
        ["primary_window", 55, reset * 1000], ["secondary_window", 30, (reset + 86400) * 1000],
      ]);
    });
  });

  it("reports the number of bound sessions", async () => {
    prime([acct("a"), acct("b")]);
    const { coreCalls } = installFetch(() => sse());
    const app = makeApp(makeConfig());
    for (const session of ["s1", "s2", "s3"]) {
      const t = turn(session);
      await (await post(app, t.path, t.headers, t.body)).text();
    }
    await vi.waitFor(() => {
      const counts = coreCalls.filter((c) => c.url.endsWith("/subscription-pool/report")).map((c) => JSON.parse(c.body))
        .filter((r) => r.active_sessions !== undefined);
      expect(counts.length).toBeGreaterThan(0);
    });
  });

  it("two concurrent first requests of one session end on one account", async () => {
    prime([acct("a"), acct("b")]);
    const { upstreamCalls } = installFetch(() => sse());
    const app = makeApp(makeConfig());
    const t = turn("s-race");
    const responses = await Promise.all([
      post(app, t.path, t.headers, t.body), post(app, t.path, t.headers, t.body),
    ]);
    await Promise.all(responses.map((r) => r.text()));
    const accounts = upstreamCalls.map(accountOf);
    expect(new Set(accounts).size).toBe(1);
    const follow = turn("s-race");
    await (await post(app, follow.path, follow.headers, follow.body)).text();
    expect(accountOf(upstreamCalls[upstreamCalls.length - 1]!)).toBe(accounts[0]);
  });

  it("passes other upstream errors through without a retry", async () => {
    prime([acct("a"), acct("b")]);
    const { upstreamCalls } = installFetch(() => jsonResponse({ error: { message: "boom" } }, 500));
    const t = turn("s1");
    const res = await post(makeApp(makeConfig()), t.path, t.headers, t.body);
    expect(res.status).toBe(500);
    expect(upstreamCalls).toHaveLength(1);
  });

  it("returns the 401 when it persists after one refresh", async () => {
    prime([acct("a"), acct("b")]);
    const { upstreamCalls } = installFetch(
      () => new Response("{}", { status: 401 }),
      (call) => (call.url.endsWith("/refresh")
        ? jsonResponse({ code: 0, data: { account_id: "a", access_token: "fresh", provider_account_id: "chatgpt-a", token_expires_at: NOW + HOUR } })
        : jsonResponse({ code: 0, data: {} })),
    );
    const t = turn("s1");
    const res = await post(makeApp(makeConfig()), t.path, t.headers, t.body);
    expect(res.status).toBe(401);
    expect(upstreamCalls).toHaveLength(2);
  });

  it("uses the client login when Core cannot list the pool accounts", async () => {
    __primeCacheForTests(SPACE, [defaultRow, poolRow]);
    const { upstreamCalls } = installFetch(() => sse(), () => { throw new Error("core down"); });
    const t = turn("s1");
    const res = await post(makeApp(makeConfig()), t.path, t.headers, t.body);
    await res.text();
    // The client sent x-tdai-user-key, so its own login is used when the pool is empty.
    expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer chatgpt-own-token");
  });

  it("never writes an access token to logs or the client response", async () => {
    prime([acct("a"), acct("b")]);
    installFetch((call) => (accountOf(call) === "chatgpt-a" ? limit429(600) : sse()));
    const t = turn("s1");
    const res = await post(makeApp(makeConfig()), t.path, t.headers, t.body);
    const text = await res.text();
    expect(text).not.toContain("secret-token");
    for (const [k, v] of res.headers.entries()) expect(`${k}: ${v}`).not.toContain("secret-token");
    expect(logs.join("\n")).not.toContain("secret-token");
    expect(logs.join("\n")).not.toContain("chatgpt-own-token");
  });
});

describe("codex auxiliary requests in a pool", () => {
  beforeEach(() => resetPoolState());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("use the bound account and never create a binding", async () => {
    prime([acct("a"), acct("b")]);
    const { upstreamCalls } = installFetch(() => sse());
    const app = makeApp(makeConfig());
    // Session s1 binds to a (first), s2 to b.
    for (const session of ["s1", "s2"]) {
      const t = turn(session);
      await (await post(app, t.path, t.headers, t.body)).text();
    }
    upstreamCalls.length = 0;
    await (await post(app, `/codex/${SPACE}/v1/responses/compact`, turn("s2").headers, { model: "gpt-5-codex", input: [] })).text();
    expect(upstreamCalls.map(accountOf)).toEqual(["chatgpt-b"]);
    expect(upstreamCalls[0]!.url).toBe(`${CHATGPT}/responses/compact`);

    // An unknown session gets some eligible account, and a following main turn is not pinned by it.
    upstreamCalls.length = 0;
    await (await post(app, `/codex/${SPACE}/v1/responses/compact`, turn("s-unknown").headers, { model: "gpt-5-codex", input: [] })).text();
    expect(upstreamCalls).toHaveLength(1);
    upstreamCalls.length = 0;
    const t3 = turn("s-unknown");
    await (await post(app, t3.path, t3.headers, t3.body)).text();
    // s3 as the third session: round-robin cursor moved only for s1 and s2, so it lands on a.
    expect(accountOf(upstreamCalls[0]!)).toBe("chatgpt-a");
  });
});

describe("utility routes in a pool", () => {
  beforeEach(() => resetPoolState());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("use an eligible account and the ChatGPT backend", async () => {
    prime([acct("a")]);
    const { upstreamCalls } = installFetch(() => jsonResponse({ data: [] }));
    const t = turn("s1");
    const res = await post(makeApp(makeConfig()), `/codex/${SPACE}/v1/embeddings`, t.headers, { model: "x", input: "hi" });
    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]!.url.startsWith(CHATGPT)).toBe(true);
    expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer secret-token-a");
    expect(accountOf(upstreamCalls[0]!)).toBe("chatgpt-a");
  });
});
