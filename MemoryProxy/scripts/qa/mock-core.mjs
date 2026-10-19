#!/usr/bin/env node
/**
 * mock-core.mjs —— 最小内核桩，用来测 Proxy 的 instance-upstream 4 态解析。
 *
 * 提供:
 *   POST /v3/meta/auth/verify              → valid=true
 *   POST /v3/internal/meta/instance-upstream/list → 按 MOCK_MODE 返回不同 rows
 *
 * MOCK_MODE:
 *   blocked-default   → default 组 enabled=false（覆盖 pi）→ 期望 400 UPSTREAM_DISABLED
 *   blocked-custom    → custom 组 enabled=false（覆盖 codebuddy）→ 期望 400 UPSTREAM_DISABLED
 *   unmanaged         → 只声明部分 agent，其余落 unmanaged → 期望 400 AGENT_NOT_CONFIGURED
 *   pool              → codex 落在 subscription_pool 组；两个账号 (acc-1, acc-2)，token 为
 *                       mock-token-1 / mock-token-2。accounts/list、report、refresh 都有桩，
 *                       report 的 body 会打印到 stdout。MOCK_POOL_BASE_URL 设置时写入组的
 *                       base_url（指向 mock 上游），否则为空（= ChatGPT 后端）。
 *
 * 用法: MOCK_MODE=blocked-default node mock-core.mjs
 */
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 18500);
const MODE = process.env.MOCK_MODE || "blocked-default";

function rowsFor(mode) {
  const allAgents = ["claude-code", "codebuddy", "codex", "workbuddy", "dsh", "opencode", "pi", "hermes", "openclaw"];
  if (mode === "blocked-default") {
    return [{
      id: 1, group_id: "dflt-mock", group_type: "default", name: "mock-default",
      agents: allAgents, enabled: false, mode: "official",
      base_url: "", api_key: "", model_id: "", description: "",
      version: 1, supported_agents_snapshot: allAgents,
      created_at: "2026-10-08T00:00:00.000Z", updated_at: "2026-10-08T00:00:00.000Z",
    }];
  }
  if (mode === "blocked-custom") {
    return [
      { id: 1, group_id: "dflt-mock", group_type: "default", name: "mock-default",
        agents: allAgents, enabled: true, mode: "official",
        base_url: "", api_key: "", model_id: "", description: "",
        version: 1, supported_agents_snapshot: allAgents,
        created_at: "2026-10-08T00:00:00.000Z", updated_at: "2026-10-08T00:00:00.000Z" },
      { id: 2, group_id: "grp-mock", group_type: "custom", name: "mock-custom-blocked",
        agents: ["codebuddy"], enabled: false, mode: "custom_unified",
        base_url: "https://api.deepseek.com", api_key: "sk-mock", model_id: "", description: "",
        version: 1, supported_agents_snapshot: [],
        created_at: "2026-10-08T00:00:00.000Z", updated_at: "2026-10-08T00:00:00.000Z" },
    ];
  }
  if (mode === "unmanaged") {
    // default 组只声明 dsh —— 其他 agent 全部落 unmanaged
    return [{
      id: 1, group_id: "dflt-mock", group_type: "default", name: "mock-default",
      agents: ["dsh"], enabled: true, mode: "official",
      base_url: "", api_key: "", model_id: "", description: "",
      version: 1, supported_agents_snapshot: ["dsh"],
      created_at: "2026-10-08T00:00:00.000Z", updated_at: "2026-10-08T00:00:00.000Z",
    }];
  }
  if (mode === "pool") {
    const stamp = "2026-10-19T00:00:00.000Z";
    return [
      { id: 1, group_id: "dflt-mock", group_type: "default", name: "mock-default",
        agents: allAgents.filter((a) => a !== "codex"), enabled: true, mode: "official",
        base_url: "", api_key: "", model_id: "", description: "",
        version: 1, supported_agents_snapshot: allAgents, created_at: stamp, updated_at: stamp },
      { id: 2, group_id: "pool-codex", group_type: "custom", name: "Codex subscription pool",
        agents: ["codex"], enabled: true, mode: "subscription_pool",
        base_url: process.env.MOCK_POOL_BASE_URL || "", api_key: "", model_id: "", description: "",
        version: 1, supported_agents_snapshot: [], created_at: stamp, updated_at: stamp },
    ];
  }
  return [];
}

function poolAccounts() {
  const farFuture = Date.now() + 8 * 3600 * 1000;
  return [1, 2].map((n) => ({
    account_id: `acc-${n}`, group_id: "pool-codex", provider: "codex",
    provider_account_id: `chatgpt-acct-${n}`, status: "active", enabled: true,
    access_token: `mock-token-${n}`, token_expires_at: farFuture,
    usage: { windows: [] }, exhausted_until: null,
  }));
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const url = req.url.split("?")[0];
    const send = (obj, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (url === "/v3/meta/auth/verify") {
      return send({
        code: 0, message: "ok", request_id: "req-mock",
        data: { valid: true, user: { user_id: "usr-mock", user_type: "normal", username: "mock", created_at: "2026-01-01T00:00:00Z" } },
      });
    }
    if (url === "/v3/internal/meta/instance-upstream/list") {
      return send({ code: 0, message: "ok", request_id: "req-mock", data: { items: rowsFor(MODE) } });
    }
    if (url === "/v3/internal/meta/subscription-pool/accounts/list") {
      return send({ code: 0, message: "ok", request_id: "req-mock", data: { threshold_pct: 95, accounts: MODE === "pool" ? poolAccounts() : [] } });
    }
    if (url === "/v3/internal/meta/subscription-pool/report") {
      console.log(`[mock-core] pool report ${body}`);
      return send({ code: 0, message: "ok", request_id: "req-mock", data: {} });
    }
    if (url === "/v3/internal/meta/subscription-pool/refresh") {
      const { account_id: accountId } = JSON.parse(body || "{}");
      return send({
        code: 0, message: "ok", request_id: "req-mock",
        data: { account_id: accountId, access_token: `mock-refreshed-${accountId}`, provider_account_id: `chatgpt-${accountId}`, token_expires_at: Date.now() + 8 * 3600 * 1000 },
      });
    }
    if (url === "/health") {
      return send({ status: "ok", version: "mock", stores: {}, services: {} });
    }
    send({ code: 404, message: `mock: no route ${url}` }, 404);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-core] listening on ${PORT}, MOCK_MODE=${MODE}`);
});
