/**
 * Explicit opt-in integration against a separate checkout of PR #1142.
 * Runs its actual conversation handler and SQLite store behind loopback HTTP.
 * No production configuration, auth service, model, or credentials are used.
 * Usage: node --import tsx/esm scripts/pi-outbox-contract.ts <1142-checkout>/MemoryCore
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { PiOutboxStore } from "../src/agent-adapters/pi-outbox-store.js";
import { PiOutboxWorker } from "../src/agent-adapters/pi-outbox-worker.js";
import { createPiOutboxSender } from "../src/agent-adapters/pi-outbox-sender.js";

if (!process.argv[2]) throw new Error("Pass the MemoryCore directory of an isolated #1142 checkout");
const core = resolve(process.argv[2]);
// Dynamic paths are deliberate: the main branch does not contain #1142.
const { VectorStore } = await import(pathToFileURL(join(core, "src/core/store/sqlite.ts")).href);
const { handleConversationAdd } = await import(pathToFileURL(join(core, "src/gateway/v2-router.ts")).href);
const directory = await mkdtemp(join(tmpdir(), "pi-outbox-1142-"));
const queue = join(directory, "queue");
const database = join(directory, "gateway.db");
let store = new VectorStore(database, 0);
store.init();
assert.equal(typeof store.claimConversationAdd, "function", "Checkout must implement #1142");
let notifications = 0;
const receipts: string[][] = [];
const bodies: string[] = [];
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v3/conversation/add");
    assert.equal(req.headers.authorization, "Bearer contract-test-key");
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push(body);
    const response = await handleConversationAdd(JSON.parse(body), { apiKey: "contract-test-key", serviceId: req.headers["x-tdai-service-id"] }, "contract-request", {
      getStore: () => store, getEmbedding: () => undefined, getStorage: () => undefined,
      logger: { debug() {}, info() {}, warn() {}, error() {} }, deployMode: "service",
      requestIsolation: { teamId: req.headers["x-tdai-team-id"], agentId: req.headers["x-tdai-agent-id"],
        userId: req.headers["x-tdai-user-id"], sessionId: req.headers["x-tdai-session-id"] },
      notifyPipeline: async () => { notifications++; },
    });
    if (response.code === 0) receipts.push(response.data.accepted_ids);
    res.writeHead(response.code === 0 ? 202 : response.code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  } catch {
    res.writeHead(500); res.end();
  }
});
const children: ChildProcess[] = [];
const require = createRequire(import.meta.url);
const loader = pathToFileURL(require.resolve("tsx/esm")).href;
const fixture = fileURLToPath(new URL("./pi-outbox-crash-worker.ts", import.meta.url));
function child(mode: string, endpoint: string, now?: number) {
  const process = spawn(globalThis.process.execPath, ["--import", loader, fixture, mode, queue, endpoint, ...(now ? [String(now)] : [])],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(process);
  let errors = "";
  process.stderr?.on("data", chunk => { errors = (errors + String(chunk)).slice(-4_000); });
  const exit = once(process, "exit");
  const message = () => Promise.race([
    once(process, "message", { signal: AbortSignal.timeout(15_000) }),
    exit.then(() => { throw new Error(`Worker exited before signalling: ${errors}`); }),
  ]);
  return { process, exit, message };
}
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const scope = { serviceId: "s", teamId: "t", agentId: "a", userId: "u", sessionId: "session" };
  const input = { scope, body: JSON.stringify({ session_id: "session", idempotency_key: "turn-1", messages: [
    { role: "user", content: "Use Java 21", timestamp: "2026-10-06T00:00:00Z" },
    { role: "assistant", content: "Understood", timestamp: "2026-10-06T00:00:01Z" },
  ] }) };
  const local = new PiOutboxStore(queue);
  await local.enqueue(input);
  const crashed = child("crash", endpoint);
  const [message] = await crashed.message();
  assert.equal(message.type, "ack-gap");
  crashed.process.kill("SIGKILL"); await crashed.exit;
  assert.equal(store.queryL0ForL1("session", undefined, 10).length, 2);
  const state = await local.inspect();
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].state, "leased");
  // Reopen the real database as well: receipt replay must survive process storage.
  store.close(); store = new VectorStore(database, 0); store.init();
  const restarted = child("recover", endpoint, state.entries[0].availableAt + 1);
  const [done] = await restarted.message();
  assert.equal(done.result.delivered, 1);
  await restarted.exit;
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(receipts[0], receipts[1]);
  assert.equal(store.queryL0ForL1("session", undefined, 10).length, 2);
  assert.equal(notifications, 1);
  assert.equal((await local.inspect()).entries.length, 0);

  // Same key + changed content must surface to the client's DLQ, not be ACKed.
  const conflict = JSON.parse(input.body);
  conflict.messages[0].content = "Use Java 17";
  const bad = await local.enqueue({ scope, body: JSON.stringify(conflict) });
  const result = await new PiOutboxWorker(local, createPiOutboxSender({ endpoint,
    idempotencyContract: "1142", resolveApiKey: () => "contract-test-key" })).flush();
  assert.equal(result.dead, 1);
  assert.equal((await local.inspect()).entries.find(entry => entry.id === bad.id)?.reason, "conflict");
  assert.equal(store.queryL0ForL1("session", undefined, 10).length, 2);
  console.log(JSON.stringify({ passed: true, gateway: core, requestsBeforeConflict: 2, l0Rows: 2,
    identicalAcceptedIds: true, pipelineNotifications: notifications, conflictInDLQ: true }));
} finally {
  for (const process of children) {
    if (process.exitCode === null && process.signalCode === null) {
      const exit = once(process, "exit"); process.kill("SIGKILL"); await exit;
    }
  }
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  store.close();
  // directory is the exact mkdtemp result, never a caller-supplied path.
  await rm(directory, { recursive: true, force: true });
}
