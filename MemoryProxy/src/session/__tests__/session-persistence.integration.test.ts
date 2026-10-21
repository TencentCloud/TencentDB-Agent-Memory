import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KvBindingRepo } from "../../db/kv-binding-repo.js";
import { KvSessionRepo } from "../../db/kv-session-repo.js";
import { MetadataClient } from "../../meta/client.js";
import { FsStorage } from "../../storage/fs-storage.js";
import { SessionStore, type SessionIdentity } from "../store.js";
import type { SessionInitState } from "../types.js";

const identity: SessionIdentity = {
  spaceId: "space-a", userId: "user-a", agentSource: "codex", sessionId: "session-a",
};
const key = "codex:session-a";
const sessionPath = "ttl/space-a/user-a/codex/session-a/inj-sess.json";

let root: string;
let metadataServer: Server | undefined;

function pending(overrides: Partial<SessionInitState> = {}): SessionInitState {
  return {
    status: "pending_asset_confirm", keyId: key, startedAt: Date.now(), attemptCount: 0,
    userId: "user-a", ...overrides,
  };
}

function initialized(overrides: Partial<SessionInitState> = {}): SessionInitState {
  return pending({
    status: "initialized", bypassed: false,
    sessionInfo: {
      session_id: "session-a", user_id: "user-a", team_id: "team-a", agent_id: "agent-a",
      task_id: "task-a", space_id: "space-a", user_key: "integration-user-key",
    },
    agentDetail: { id: "agent-a", name: "Coding agent", prompt: "Be precise" },
    taskDetail: { id: "task-a", name: "Review tests" },
    ...overrides,
  });
}

function node(ttl = 60_000) {
  // Each node owns fresh adapters and an empty L1; only the directory is shared.
  const storage = new FsStorage(root);
  const repo = new KvSessionRepo(storage);
  const bindings = new KvBindingRepo(storage);
  const store = new SessionStore(ttl, repo, bindings);
  return { storage, repo, bindings, store };
}

async function readRow(repo: KvSessionRepo, id = identity) {
  return repo.getBySessionId(id.spaceId ?? "", id.userId, id.agentSource, id.sessionId);
}

async function startMetadataServer() {
  const requests: Array<{ url: string | undefined; headers: IncomingMessage["headers"]; body: Record<string, unknown> }> = [];
  const status = { agent: 200, task: 200 };
  metadataServer = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({ url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      const resource = request.url === "/v3/meta/agent/get" ? "agent" : "task";
      const data = resource === "agent"
        ? { agent_id: "agent-a", team_id: "team-a", name: "Recovered agent", prompt: "Recovered instructions" }
        : { task_id: "task-a", team_id: "team-a", title: "Recovered task" };
      response.writeHead(status[resource], { "content-type": "application/json" });
      response.end(JSON.stringify(status[resource] === 200
        ? { code: 0, data }
        : { code: status[resource], message: "metadata unavailable" }));
    })().catch((error) => response.destroy(error));
  });
  await new Promise<void>((resolve, reject) => {
    metadataServer!.once("error", reject);
    metadataServer!.listen(0, "127.0.0.1", resolve);
  });
  const endpoint = `http://127.0.0.1:${(metadataServer.address() as AddressInfo).port}`;
  const metadataClient = new MetadataClient({ endpoint, serviceToken: "integration-gateway-key", timeoutMs: 2_000 }, "space-a", "integration-user-key");
  return { requests, status, metadataClient };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "proxy-session-integration-"));
  // Silence routine cache diagnostics; persistence and HTTP behavior stay real.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  if (metadataServer) {
    const active = metadataServer;
    metadataServer = undefined;
    const closed = new Promise<void>((resolve, reject) => active.close((error) => error ? reject(error) : resolve()));
    active.closeAllConnections();
    await closed;
  }
  // Recovery schedules touchLastSeen without awaiting it. Joining the same
  // per-key mutex drains those writes before the temporary directory is removed.
  await new KvBindingRepo(new FsStorage(root)).touchLastSeen("space-a", "session-a");
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("SessionStore + KV repositories + filesystem", () => {
  it("makes an awaited pending write immediately recoverable by another node", async () => {
    const first = node();
    first.store.bind(key, identity);
    const state = pending({ resetFlow: true, resetEpoch: 7 });
    await first.store.set(key, state);
    const second = node();
    const restored = await second.store.getOrRecover(key, identity, {});
    expect(restored).toEqual(state);
    expect(restored?.__recoverySource).toBe("l2a");
    expect(second.store.getBoundIdentity(key)).toEqual(identity);
    await second.store.set(key, restored!);
    expect(await readRow(first.repo)).toEqual(state);
    expect(await first.storage.getText(sessionPath)).not.toContain("__recoverySource");
  });

  it("refreshes stale L1 state after another node advances session initialization", async () => {
    const first = node();
    const second = node();
    first.store.bind(key, identity);
    await first.store.set(key, pending());
    await second.store.getOrRecover(key, identity, {});
    await second.store.set(key, pending({ status: "pending_agent_select", selectedTeamId: "team-a" }));
    expect(first.store.get(key)?.status).toBe("pending_asset_confirm");
    const refreshed = await first.store.getOrRecover(key, identity, {});
    expect(refreshed?.status).toBe("pending_agent_select");
    expect(first.store.get(key)?.selectedTeamId).toBe("team-a");
  });

  it.each([
    { field: "space", changed: { spaceId: "space-b" } },
    { field: "user", changed: { userId: "user-b" } },
    { field: "client", changed: { agentSource: "claude-code" } },
  ])("persists independent pending states for the same session ID under a different $field", async ({ changed }) => {
    const original = node();
    const other = node();
    const otherIdentity = { ...identity, ...changed };
    original.store.bind(key, identity);
    other.store.bind(key, otherIdentity);
    await original.store.set(key, pending({ attemptCount: 1 }));
    await other.store.set(key, pending({ userId: otherIdentity.userId, attemptCount: 2 }));
    const originalReader = node();
    const otherReader = node();
    expect((await originalReader.store.getOrRecover(key, identity, {}))?.attemptCount).toBe(1);
    expect((await otherReader.store.getOrRecover(key, otherIdentity, {}))?.attemptCount).toBe(2);
    expect(await original.storage.listNames("ttl/")).toHaveLength(2);
  });

  it("drops expired pending persistence while retaining initialized sessions beyond the pending TTL", async () => {
    const first = node(100);
    first.store.bind(key, identity);
    await first.store.set(key, pending({ startedAt: Date.now() - 1_000 }));
    expect(await node(100).store.getOrRecover(key, identity, {})).toBeUndefined();
    // Repository invalidation is intentionally asynchronous.
    await expect.poll(() => readRow(first.repo), { timeout: 2_000 }).toBeNull();
    await first.store.set(key, initialized({ startedAt: Date.now() - 1_000 }));
    const restored = await node(100).store.getOrRecover(key, identity, {});
    expect(restored?.status).toBe("initialized");
    expect(restored?.bypassed).toBe(false);
  });

  it("treats a truncated persisted JSON document as a cache miss", async () => {
    const writer = node();
    await writer.storage.putText(sessionPath, '{"status":"pending_asset_confirm"');
    expect(await node().store.getOrRecover(key, identity, {})).toBeUndefined();
  });

  it("hydrates only completed sessions from actual persisted rows", async () => {
    const writer = node();
    writer.store.bind(key, identity);
    await writer.store.set(key, initialized());
    const pendingIdentity = { ...identity, sessionId: "pending-session" };
    writer.store.bind("codex:pending-session", pendingIdentity);
    await writer.store.set("codex:pending-session", pending({ keyId: "codex:pending-session" }));
    const restarted = node();
    expect(await restarted.store.hydrateFromDb()).toBe(1);
    expect(restarted.store.get(key)?.sessionInfo?.agent_id).toBe("agent-a");
    expect(restarted.store.getBoundIdentity(key)).toEqual(identity);
    expect(restarted.store.get("codex:pending-session")).toBeUndefined();
  });
});

describe("persistent binding recovery through a real MetadataClient HTTP connection", () => {
  async function persistBindingOnly() {
    const writer = node();
    writer.store.bind(key, identity);
    await writer.store.set(key, initialized());
    await writer.storage.del(sessionPath);
    return writer;
  }

  it("rebuilds full session state after L2a loss and writes it through for the next node", async () => {
    const writer = await persistBindingOnly();
    const backend = await startMetadataServer();
    const reader = node();
    const recovered = await reader.store.getOrRecover(key, identity, { metadataClient: backend.metadataClient });
    expect(recovered).toMatchObject({
      status: "initialized", bypassed: false, __recoverySource: "l2b",
      sessionInfo: { space_id: "space-a", user_key: "integration-user-key", agent_id: "agent-a", task_id: "task-a" },
      agentDetail: { name: "Recovered agent", prompt: "Recovered instructions" },
      taskDetail: { name: "Recovered task" },
    });
    expect(backend.requests.map((request) => request.url).sort()).toEqual(["/v3/meta/agent/get", "/v3/meta/task/get"]);
    for (const request of backend.requests) {
      expect(request.headers).toMatchObject({
        authorization: "Bearer integration-gateway-key", "x-tdai-service-id": "space-a", "x-tdai-user-key": "integration-user-key",
      });
    }
    expect(await readRow(writer.repo)).toMatchObject({ agentDetail: { name: "Recovered agent" } });
    expect((await node().store.getOrRecover(key, identity, {}))?.__recoverySource).toBe("l2a");
    expect(backend.requests).toHaveLength(2);
  });

  it("keeps the binding after a temporary HTTP failure and retries recovery on the next request", async () => {
    const writer = await persistBindingOnly();
    const backend = await startMetadataServer();
    backend.status.agent = 503;
    const reader = node();
    const first = await reader.store.getOrRecover(key, identity, { metadataClient: backend.metadataClient });
    expect(first?.bypassed).toBe(true);
    expect(reader.store.get(key)).toBeUndefined();
    expect(await readRow(writer.repo)).toBeNull();
    expect(await writer.bindings.getBinding("space-a", "session-a")).toMatchObject({ agentId: "agent-a", taskId: "task-a" });
    backend.status.agent = 200;
    const retried = await reader.store.getOrRecover(key, identity, { metadataClient: backend.metadataClient });
    expect(retried?.bypassed).toBe(false);
    expect(retried?.agentDetail?.name).toBe("Recovered agent");
  });

  it("drops a deleted task from the binding but retains the recovered agent", async () => {
    const writer = await persistBindingOnly();
    const backend = await startMetadataServer();
    backend.status.task = 404;
    const recovered = await node().store.getOrRecover(key, identity, { metadataClient: backend.metadataClient });
    expect(recovered?.agentDetail?.id).toBe("agent-a");
    expect(recovered?.taskDetail).toBeNull();
    expect(recovered?.sessionInfo?.task_id).toBeUndefined();
    expect((await writer.bindings.getBinding("space-a", "session-a"))?.taskId).toBeUndefined();
  });

  it("invalidates a binding whose agent was deleted instead of caching an unusable session", async () => {
    const writer = await persistBindingOnly();
    const backend = await startMetadataServer();
    backend.status.agent = 404;
    expect(await node().store.getOrRecover(key, identity, { metadataClient: backend.metadataClient })).toBeUndefined();
    expect(await writer.bindings.getBinding("space-a", "session-a")).toBeNull();
    expect(await readRow(writer.repo)).toBeNull();
  });
});
