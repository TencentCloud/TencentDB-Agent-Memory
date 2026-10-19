import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writeLogMock = vi.hoisted(() => vi.fn());
vi.mock("../../logger.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../logger.js")>();
  return { ...original, writeLog: writeLogMock };
});

import { buildClickHouseRow } from "../../clickhouse.js";
import { __primeCacheForTests, type InstanceUpstreamRow } from "../../instance-upstream-cache.js";
import { __primeAccountCacheForTests } from "../account-cache.js";
import { installFetch, makeApp, makeConfig, resetPoolState } from "./test-harness.js";
import type { PoolAccount } from "../types.js";

const SPACE = "sp-log";
const rows: InstanceUpstreamRow[] = [
  { group_id: "d", group_type: "default", name: "d", agents: ["claude-code"], enabled: true, mode: "official", base_url: "", api_key: "", model_id: "" },
  { group_id: "p", group_type: "custom", name: "p", agents: ["codex"], enabled: true, mode: "subscription_pool", base_url: "", api_key: "", model_id: "" },
];
const account: PoolAccount = {
  account_id: "acc-log", group_id: "p", provider: "codex", provider_account_id: "chatgpt-log", status: "active", enabled: true,
  access_token: "tok", token_expires_at: Date.now() + 3_600_000, usage: { windows: [] }, exhausted_until: null,
};

const completed = JSON.stringify({ type: "response.completed", response: { id: "r", usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } } });
const sseBody = `event: response.completed\ndata: ${completed}\n\n`;

describe("usage rows of pool requests", () => {
  beforeEach(() => { resetPoolState(); writeLogMock.mockClear(); });
  afterEach(() => vi.unstubAllGlobals());

  it("record the serving account for a streamed turn", async () => {
    __primeCacheForTests(SPACE, rows);
    __primeAccountCacheForTests(SPACE, { thresholdPct: 95, accounts: [account] });
    installFetch(() => new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const res = await makeApp(makeConfig()).request(`/codex/${SPACE}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tdai-user-key": "sk", authorization: "Bearer own", "session-id": "s1" },
      body: JSON.stringify({ model: "gpt-5", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] }),
    });
    await res.text();
    await vi.waitFor(() => {
      const usage = writeLogMock.mock.calls.map((c) => c[1]).filter((e) => e.event === "usage");
      expect(usage.length).toBeGreaterThan(0);
      expect(usage[0].subscriptionAccountId).toBe("acc-log");
    });
  });

  it("do not carry the field outside a pool", async () => {
    __primeCacheForTests(SPACE, [rows[0]!, { ...rows[1]!, mode: "custom_passthrough", base_url: "http://custom.test/api" }]);
    installFetch(() => new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const res = await makeApp(makeConfig()).request(`/codex/${SPACE}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer own", "session-id": "s1" },
      body: JSON.stringify({ model: "gpt-5", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] }),
    });
    await res.text();
    await vi.waitFor(() => {
      expect(writeLogMock.mock.calls.some((c) => c[1].event === "usage")).toBe(true);
    });
    for (const call of writeLogMock.mock.calls) expect("subscriptionAccountId" in call[1]).toBe(false);
  });
});

describe("buildClickHouseRow", () => {
  const base = {
    timestamp: "2026-10-19T00:00:00.000Z", event: "usage", modelId: "m", keyId: "k", upstreamUrl: "u", stream: true,
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  };
  it("fills subscription_account_id for pool requests and leaves it empty otherwise", () => {
    expect(buildClickHouseRow({ ...base, subscriptionAccountId: "acc-1" })?.subscription_account_id).toBe("acc-1");
    expect(buildClickHouseRow(base)?.subscription_account_id).toBe("");
  });
});
