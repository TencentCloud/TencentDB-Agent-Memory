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
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { PiOutboxStore } from "../src/agent-adapters/pi-outbox-store.js";
import { PiOutboxWorker, type PiOutboxFlushResult, type PiOutboxPolicy } from "../src/agent-adapters/pi-outbox-worker.js";
import { createPiOutboxSender } from "../src/agent-adapters/pi-outbox-sender.js";
import { runPiOutboxCommand } from "../src/agent-adapters/pi-outbox-cli.js";

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
interface Observation { body: string; session: string; code: number; acceptedIds?: string[] }
interface WorkerMessage { type: string; records?: number; result?: PiOutboxFlushResult }
const observations: Observation[] = [];
const sessionNotifications = new Map<string, number>();
const faults = new Map<string, { dropReplies?: number; gate?: Promise<void> }>();
const releaseGates: (() => void)[] = [];
const serverErrors: string[] = [];
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v3/conversation/add");
    assert.equal(req.headers.authorization, "Bearer contract-test-key");
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push(body);
    const parsed = JSON.parse(body);
    const response = await handleConversationAdd(parsed, { apiKey: "contract-test-key", serviceId: req.headers["x-tdai-service-id"] }, "contract-request", {
      getStore: () => store, getEmbedding: () => undefined, getStorage: () => undefined,
      logger: { debug() {}, info() {}, warn() {}, error() {} }, deployMode: "service",
      requestIsolation: { teamId: req.headers["x-tdai-team-id"], agentId: req.headers["x-tdai-agent-id"],
        userId: req.headers["x-tdai-user-id"], sessionId: req.headers["x-tdai-session-id"] },
      notifyPipeline: async (_service: string, session: string) => {
        notifications++;
        sessionNotifications.set(session, (sessionNotifications.get(session) ?? 0) + 1);
      },
    });
    if (response.code === 0) receipts.push(response.data.accepted_ids);
    observations.push({ body, session: parsed.session_id, code: response.code,
      acceptedIds: response.code === 0 ? response.data.accepted_ids : undefined });
    // Faults apply AFTER the real handler commits L0, its receipt and pipeline
    // notification. Never replace it with a fake successful database write.
    const fault = faults.get(parsed.session_id);
    if (fault?.gate) await fault.gate;
    if (response.code === 0 && fault?.dropReplies) { fault.dropReplies--; return; }
    if (!res.destroyed) {
      res.writeHead(response.code === 0 ? 202 : response.code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    }
  } catch (error) {
    serverErrors.push(error instanceof Error ? error.message : "Gateway test error");
    if (!res.destroyed) { res.writeHead(500); res.end(); }
  }
});
const children: ChildProcess[] = [];
const require = createRequire(import.meta.url);
const loader = pathToFileURL(require.resolve("tsx/esm")).href;
const fixture = fileURLToPath(new URL("./pi-outbox-crash-worker.ts", import.meta.url));
function child(mode: string, endpoint: string, now?: number,
  options: { queue?: string; policy?: Partial<PiOutboxPolicy> } = {}) {
  const process = spawn(globalThis.process.execPath, ["--import", loader, fixture, mode, options.queue ?? queue,
    endpoint, now === undefined ? "" : String(now), JSON.stringify(options.policy ?? {})],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(process);
  let errors = "";
  process.stderr?.on("data", chunk => { errors = (errors + String(chunk)).slice(-4_000); });
  // Buffer IPC so a fast child cannot signal before the parent starts waiting.
  const messages: WorkerMessage[] = [];
  const waiters: { resolve: (messages: [WorkerMessage]) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }[] = [];
  process.on("message", value => {
    const message = value as WorkerMessage;
    const waiter = waiters.shift();
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve([message]); } else messages.push(message);
  });
  const rejectWaiters = () => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer); waiter.reject(new Error(`Worker exited before signalling: ${errors}`));
    }
  };
  process.once("exit", rejectWaiters); process.once("error", rejectWaiters);
  const exit = once(process, "exit");
  void exit.catch(() => {});
  const message = (): Promise<[WorkerMessage]> => {
    if (messages.length) return Promise.resolve([messages.shift()!]);
    if (process.exitCode !== null || process.signalCode !== null) return Promise.reject(new Error(`Worker already exited: ${errors}`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex(waiter => waiter.timer === timer);
        if (index !== -1) waiters.splice(index, 1);
        reject(new Error(`Worker signal timed out: ${errors}`));
      }, 15_000);
      waiters.push({ resolve, reject, timer });
    });
  };
  return { process, exit, message, queue: options.queue ?? queue };
}
async function completed(worker: ReturnType<typeof child>) {
  const [message] = await worker.message();
  assert.equal(message.type, "complete"); assert(message.result);
  assert.deepEqual(await worker.exit, [0, null]);
  assert.deepEqual(message.result.errors, []); assert.deepEqual(message.result.unreadable, []);
  assert.equal(message.result.lost, 0, JSON.stringify({ result: message.result,
    queue: await new PiOutboxStore(worker.queue).inspect(), requests: observations }));
  return message.result;
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) { assert(Date.now() < deadline, "Gateway observation timed out"); await delay(10); }
}
function scenario(session: string) {
  const scope = { serviceId: "s", teamId: "t", agentId: "a", userId: "u", sessionId: session };
  const input = { scope, body: JSON.stringify({ session_id: session, idempotency_key: `turn-${session}`, messages: [
    { role: "user", content: "Use Java 21", timestamp: "2026-10-06T00:00:00Z" },
    { role: "assistant", content: "Understood", timestamp: "2026-10-06T00:00:01Z" },
  ] }) };
  const queue = join(directory, session);
  return { scope, input, queue, local: new PiOutboxStore(queue) };
}
function requests(session: string) { return observations.filter(item => item.session === session); }
function reopenDatabase() { store.close(); store = new VectorStore(database, 0); store.init(); }
function databaseState(test: ReturnType<typeof scenario>) {
  const receipt = store.readConversationAddReceipt({ ...test.scope, idempotencyKey: JSON.parse(test.input.body).idempotency_key });
  assert(receipt); assert.equal(receipt.status, "completed");
  const observer = new DatabaseSync(database, { readOnly: true });
  try {
    const count = (sql: string) => Number(observer.prepare(sql).get(test.scope.sessionId)?.count);
    const l0Rows = count("SELECT COUNT(*) AS count FROM l0_conversations WHERE session_id = ?");
    const receiptRows = count("SELECT COUNT(*) AS count FROM conversation_add_receipts WHERE session_id = ?");
    const completedReceipts = count("SELECT COUNT(*) AS count FROM conversation_add_receipts WHERE session_id = ? AND status = 'completed'");
    const acknowledgedOutbox = count("SELECT COUNT(*) AS count FROM conversation_add_outbox WHERE session_id = ? AND status = 'acknowledged'");
    assert.equal(l0Rows, 2); assert.equal(receiptRows, 1); assert.equal(completedReceipts, 1); assert.equal(acknowledgedOutbox, 1);
    assert.equal(sessionNotifications.get(test.scope.sessionId), 1);
    return { receiptId: receipt.receiptId as string, acceptedIds: receipt.acceptedIds as string[], l0Rows, completedReceipts,
      pipelineNotifications: sessionNotifications.get(test.scope.sessionId)! };
  } finally { observer.close(); }
}
function assertReplay(test: ReturnType<typeof scenario>, attempts: number, originalReceiptId: string) {
  const accepted = requests(test.scope.sessionId).filter(item => item.code === 0);
  assert.equal(accepted.length, attempts);
  const state = databaseState(test); assert.equal(state.receiptId, originalReceiptId);
  for (const observation of accepted) {
    assert.equal(observation.body, test.input.body); assert.deepEqual(observation.acceptedIds, state.acceptedIds);
  }
  return { deliveryAttempts: attempts, l0Rows: state.l0Rows, completedReceipts: state.completedReceipts,
    pipelineNotifications: state.pipelineNotifications, identicalAcceptedIds: true };
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
  const originalAckReceipt = databaseState({ scope, input, queue, local }).receiptId;
  // Reopen the real database as well: receipt replay must survive process storage.
  store.close(); store = new VectorStore(database, 0); store.init();
  const restarted = child("recover", endpoint, state.entries[0].availableAt + 1);
  const [done] = await restarted.message();
  assert(done.result);
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
  const ackTest = { scope, input, queue, local };
  const ackReceipt = originalAckReceipt;
  const ackGap = assertReplay(ackTest, 2, ackReceipt);
  assert.equal(requests("session").at(-1)?.code, 409);

  // Database commit succeeds, but the client receives no HTTP receipt.
  const timeout = scenario("timeout");
  await timeout.local.enqueue(timeout.input);
  faults.set("timeout", { dropReplies: 1 });
  assert.equal((await completed(child("recover", endpoint, undefined,
    { queue: timeout.queue, policy: { timeoutMs: 1_000 } }))).retried, 1);
  const pending = (await timeout.local.inspect()).entries[0];
  assert.equal(pending.state, "pending"); assert.equal(pending.reason, "timeout"); assert.equal(pending.attempts, 1);
  const timeoutReceipt = databaseState(timeout).receiptId;
  reopenDatabase();
  assert.equal((await completed(child("recover", endpoint, pending.availableAt + 1, { queue: timeout.queue }))).delivered, 1);
  assert.equal((await timeout.local.inspect()).entries.length, 0);
  const timeoutAfterCommit = assertReplay(timeout, 2, timeoutReceipt);

  // Force two OS processes to share a candidate snapshot before either claims.
  const racing = scenario("race");
  await racing.local.enqueue(racing.input);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  releaseGates.push(release); faults.set("race", { gate });
  const workers = [child("race", endpoint, undefined, { queue: racing.queue }),
    child("race", endpoint, undefined, { queue: racing.queue })];
  for (const worker of workers) assert.deepEqual((await worker.message())[0], { type: "ready", records: 1 });
  const completions = workers.map(worker => completed(worker));
  for (const worker of workers) worker.process.send({ type: "start" });
  const losingPass = await Promise.race(completions);
  assert.equal(losingPass.delivered, 0); assert.equal(losingPass.retried, 0); assert.equal(losingPass.dead, 0);
  await waitFor(() => requests("race").length === 1);
  assert.equal((await racing.local.inspect()).entries[0].attempts, 1);
  const raceReceipt = databaseState(racing).receiptId;
  release();
  const passes = await Promise.all(completions);
  assert.equal(passes.reduce((sum, pass) => sum + pass.delivered, 0), 1);
  assert.equal((await racing.local.inspect()).entries.length, 0);
  const concurrentWorkers = { ...assertReplay(racing, 1, raceReceipt), competingWorkers: 2 };

  // Lose two receipts AFTER database commit, exhaust the delivery budget, then
  // operator-redrive the same obligation against the already terminal receipt.
  const dead = scenario("redrive");
  const original = await dead.local.enqueue(dead.input);
  faults.set("redrive", { dropReplies: 2 });
  const policy = { timeoutMs: 1_000, maxAttempts: 2 };
  assert.equal((await completed(child("recover", endpoint, undefined, { queue: dead.queue, policy }))).retried, 1);
  const next = (await dead.local.inspect()).entries[0].availableAt + 1;
  assert.equal((await completed(child("recover", endpoint, next, { queue: dead.queue, policy }))).dead, 1);
  const dlq = (await dead.local.inspect()).entries[0];
  assert.equal(dlq.id, original.id); assert.equal(dlq.state, "dead"); assert.equal(dlq.reason, "timeout"); assert.equal(dlq.attempts, 2);
  const terminalReceipt = databaseState(dead).receiptId;
  assertReplay(dead, 2, terminalReceipt);
  reopenDatabase();
  assert.equal(await runPiOutboxCommand(["redrive", dead.queue, original.id], {}, () => {}), 0);
  assert.deepEqual((await dead.local.recover()).records, [original]);
  assert.equal((await dead.local.inspect()).entries[0].attempts, 0);
  assert.equal((await completed(child("recover", endpoint, undefined, { queue: dead.queue, policy }))).delivered, 1);
  assert.equal((await dead.local.inspect()).entries.length, 0);
  const redriveAfterTerminal = assertReplay(dead, 3, terminalReceipt);

  assert.deepEqual(serverErrors, []);
  console.log(JSON.stringify({ passed: true, gateway: core, requestsBeforeConflict: 2, l0Rows: 2,
    identicalAcceptedIds: true, pipelineNotifications: 1, conflictInDLQ: true, totalPipelineNotifications: notifications,
    scenarios: { ackGap, payloadConflict: { status: 409, inDLQ: true, l0Rows: 2 },
      timeoutAfterCommit, concurrentWorkers, redriveAfterTerminal } }));
} finally {
  for (const release of releaseGates) release();
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
