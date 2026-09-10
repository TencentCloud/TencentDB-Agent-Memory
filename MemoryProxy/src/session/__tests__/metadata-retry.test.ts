import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetadataClient } from "../../meta/client.js";
import { handleSessionInit } from "../claude-code/init.js";
import { SessionStore } from "../store.js";
import { KvSessionRepo } from "../../db/kv-session-repo.js";
import { FsStorage } from "../../storage/fs-storage.js";
import type { SessionInitConfig } from "../../types.js";

const config = { enabled: true, headerAutoSelect: { enabled: true, onMismatch: "form" } } as SessionInitConfig;
const preset = { teamId: "team", agentId: "agent", taskId: "task" };
const key = "claude-code:session";
const messages = [{ role: "user", content: "hello" }];
let server: Server;
let client: MetadataClient;
let failing: boolean;
let requests: string[];
let directory: string;

beforeEach(async () => {
  failing = true;
  requests = [];
  directory = await mkdtemp(join(tmpdir(), "session-retry-"));
  server = createServer((req, res) => {
    const path = req.url!;
    requests.push(path);
    req.resume();
    // Leave the socket open: the real MetadataClient must hit its HTTP timeout.
    if (failing && path === "/v3/meta/agent/list") return;
    const items = path.includes("/team/") ? [{ team_id: "team", name: "Team" }]
      : path.includes("/agent/") ? [{ agent_id: "agent", team_id: "team", name: "Agent" }]
      : [{ task_id: "task", team_id: "team", title: "Task" }];
    const data = path.endsWith("/list") ? { items, total: 1, limit: 100, offset: 0 }
      : path.endsWith("/get") ? items[0] : {};
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ code: 0, data }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  client = new MetadataClient({ endpoint: `http://127.0.0.1:${address.port}`, serviceToken: "test", timeoutMs: 100 }, "space", "test");
});

afterEach(async () => {
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

function run(store: SessionStore, selected: typeof preset | null = preset, input = messages) {
  return handleSessionInit("session", "user", input, config, store,
    { stream: false, modelId: "test", protocol: "anthropic" }, client, "test", "space", selected ?? undefined);
}

describe("Claude Code metadata timeout recovery", () => {
  it("retries the same session after the directory recovers, then registers only once", async () => {
    const store = new SessionStore();
    const now = Date.now();
    expect((await run(store)).bypassed).toBe(true);
    failing = false;
    vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
    const result = await run(store);
    expect(result.sessionInfo?.agent_id).toBe("agent");
    expect(result.sessionInfo?.task_id).toBe("task");
    expect(result.systemAppend).toContain("agent");
    expect(requests.filter((p) => p === "/v3/meta/agent/list")).toHaveLength(2);
    await expect.poll(() => requests.filter((p) => p.endsWith("/participation-log/append")).length).toBe(1);
    const count = requests.length;
    await run(store);
    expect(requests).toHaveLength(count);
    expect(store.get(key)?.bypassed).not.toBe(true);
  });

  it("preserves the cooldown through disk recovery and does not persist an opt-out", async () => {
    const identity = { spaceId: "space", userId: "user", agentSource: "claude-code", sessionId: "session" };
    const repo = new KvSessionRepo(new FsStorage(directory));
    const store = new SessionStore(60_000, repo);
    store.bind(key, identity);
    await run(store);
    const restarted = new SessionStore(60_000, new KvSessionRepo(new FsStorage(directory)));
    await restarted.getOrRecover(key, identity, {});
    expect(restarted.get(key)?.status).toBe("uninitialized");
    expect(restarted.get(key)?.bypassed).not.toBe(true);
    const retryAt = restarted.get(key)!.metadataRetryAt!;
    const clock = vi.spyOn(Date, "now").mockReturnValue(retryAt - 1);
    const count = requests.length;
    failing = false;
    expect((await run(restarted, null)).bypassed).toBe(true);
    expect(requests).toHaveLength(count);
    clock.mockReturnValue(retryAt);
    expect((await run(restarted, null)).intercepted).toBe(true);
    expect(restarted.get(key)?.status).toBe("pending_asset_confirm");
    expect(restarted.get(key)?.metadataRetryAt).toBeUndefined();
  });

  it("preserves a session reset through a metadata timeout and retry", async () => {
    const store = new SessionStore();
    await store.set(key, { status: "uninitialized", keyId: "session", startedAt: Date.now(),
      attemptCount: 0, resetFlow: true, resetEpoch: 7 });
    expect((await run(store, null)).resetFlow).toBe(true);
    expect(store.get(key)?.resetEpoch).toBe(7);
    expect((await run(store, null)).resetFlow).toBe(true);
    failing = false;
    vi.spyOn(Date, "now").mockReturnValue(store.get(key)!.metadataRetryAt!);
    expect((await run(store, null)).intercepted).toBe(true);
    expect(store.get(key)?.resetFlow).toBe(true);
    expect(store.get(key)?.resetEpoch).toBe(7);
  });

  it("spaces repeated failures rather than retrying on every request", async () => {
    const store = new SessionStore();
    await run(store);
    const retryAt = store.get(key)!.metadataRetryAt!;
    const clock = vi.spyOn(Date, "now").mockReturnValue(retryAt);
    expect((await run(store)).bypassed).toBe(true);
    expect(store.get(key)?.status).toBe("uninitialized");
    expect(store.get(key)?.metadataRetryAt).toBe(retryAt + 30_000);
    clock.mockReturnValue(retryAt + 1);
    const count = requests.length;
    await run(store);
    expect(requests).toHaveLength(count);
  });

  it("keeps an explicit no-assets answer terminal", async () => {
    failing = false;
    const store = new SessionStore();
    expect((await run(store, null)).intercepted).toBe(true);
    expect((await run(store, null, [{ role: "user", content: "否，本次不关联" }])).bypassed).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    const count = requests.length;
    expect((await run(store, null)).bypassed).toBe(true);
    expect(store.get(key)?.status).toBe("initialized");
    expect(requests).toHaveLength(count);
  });
});
