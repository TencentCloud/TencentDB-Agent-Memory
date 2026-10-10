/** Real Pi + actual Proxy entrypoint + #1142 SQLite. Model/auth/metadata use local fixtures.
 * node --import tsx/esm scripts/pi-outbox-e2e.ts <1142>/MemoryCore <pi-checkout>
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { PiOutboxStore } from "../src/agent-adapters/pi-outbox-store.js";

if (!process.argv[2] || !process.argv[3]) throw new Error("Pass isolated #1142 MemoryCore and Pi checkout directories");
const core = resolve(process.argv[2]);
const pi = resolve(process.argv[3]);
const proxy = fileURLToPath(new URL("../", import.meta.url));
const { VectorStore } = await import(pathToFileURL(join(core, "src/core/store/sqlite.ts")).href);
const { handleConversationAdd } = await import(pathToFileURL(join(core, "src/gateway/v2-router.ts")).href);
const directory = await mkdtemp(join(tmpdir(), "pi-outbox-e2e-"));
const queue = new PiOutboxStore(join(directory, "outbox"));
const dbPath = join(directory, "gateway.db");
const store = new VectorStore(dbPath, 0); store.init();
const children: ChildProcess[] = [];
const childLogs: string[] = [];
const liveLogs: (() => string)[] = [];
const notifications = new Map<string, number>();
const deliveries: { key: string; body: string; ids: string[] }[] = [];
let dropReply = false;
let gatewayDown = false;
let toolObserved = false;
let modelCalls = 0;
const fixtureFile = join(directory, "read-me.txt");
const marker = "PI_OUTBOX_REAL_READ_OK";
await writeFile(fixtureFile, marker);
const server = createServer(async (req, res) => {
  try {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = req.url ?? "";
    const reply = (data: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (url === "/v3/conversation/add") {
      assert.equal(req.headers.authorization, "Bearer fixture-gateway");
      if (gatewayDown) { reply({ code: 503 }, 503); return; }
      const response = await handleConversationAdd(body, { apiKey: "fixture-gateway", serviceId: req.headers["x-tdai-service-id"] }, "fixture-request", {
        getStore: () => store, getEmbedding: () => undefined, getStorage: () => undefined,
        logger: { debug() {}, info() {}, warn() {}, error() {} }, deployMode: "service",
        requestIsolation: { teamId: req.headers["x-tdai-team-id"], agentId: req.headers["x-tdai-agent-id"],
          userId: req.headers["x-tdai-user-id"], sessionId: req.headers["x-tdai-session-id"] },
        notifyPipeline: async (_service: string, session: string) => notifications.set(session, (notifications.get(session) ?? 0) + 1),
      });
      assert.equal(response.code, 0);
      deliveries.push({ key: body.idempotency_key, body: raw, ids: response.data.accepted_ids });
      if (dropReply) return;
      reply(response, 202); return;
    }
    if (url === "/v3/meta/auth/verify") {
      reply({ code: 0, data: { valid: body.user_key === "fixture-user", user: { user_id: "u" } } }); return;
    }
    if (url.includes("/v3/meta/agent/get")) {
      reply({ code: 0, data: { agent: { agent_id: "a", team_id: "t", name: "fixture-agent" } } }); return;
    }
    if (url.includes("/chat/completions")) {
      if (!Array.isArray(body.messages)) { reply({ error: "messages required" }, 400); return; }
      modelCalls++;
      const wantsTool = JSON.stringify(body.messages).includes("outbox-read");
      const tool = body.messages.findLast((message: { role: string }) => message.role === "tool");
      if (tool) { assert(JSON.stringify(tool).includes(marker)); toolObserved = true; }
      const toolCall = wantsTool && !tool;
      const content = toolCall ? null : wantsTool ? marker : "PI_OUTBOX_OK";
      const toolCalls = toolCall ? [{ index: 0, id: "call_read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: fixtureFile }) } }] : undefined;
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const event = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: body.model,
          choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        res.end(event({ role: "assistant", ...(toolCall ? { tool_calls: toolCalls } : { content }) }, null)
          + event({}, toolCall ? "tool_calls" : "stop") + "data: [DONE]\n\n");
      } else reply({ choices: [{ message: { role: "assistant", content, tool_calls: toolCalls }, finish_reason: toolCall ? "tool_calls" : "stop" }] });
      return;
    }
    reply({ code: 0, data: { items: [], total: 0 } });
  } catch (error) { res.writeHead(500); res.end(); childLogs.push(`fixture error: ${String(error)}`); }
});
const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
async function waitFor(check: () => Promise<boolean> | boolean, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (!await check()) { assert(Date.now() < end, "E2E condition timed out"); await delay(100); }
}
function child(args: string[], env: NodeJS.ProcessEnv = {}) {
  const process = spawn(globalThis.process.execPath, args, { cwd: directory, env: { ...globalThis.process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(process);
  let output = "";
  liveLogs.push(() => output);
  for (const stream of [process.stdout, process.stderr]) stream?.on("data", chunk => { output = (output + String(chunk)).slice(-80_000); });
  const exit = once(process, "exit"); void exit.catch(() => {});
  return { process, exit, output: () => output };
}
async function kill(process: ChildProcess) {
  if (process.exitCode === null && process.signalCode === null) {
    const ended = once(process, "exit");
    if (globalThis.process.platform === "win32") {
      await promisify(execFile)("taskkill", ["/PID", String(process.pid), "/T", "/F"]).catch(() => process.kill("SIGKILL"));
    } else process.kill("SIGKILL");
    await ended;
  }
}
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const reserved = reservation.address(); assert(reserved && typeof reserved !== "string");
  const port = reserved.port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const proxyUrl = `http://127.0.0.1:${port}`;
  const configuration = {
    server: { host: "127.0.0.1", port }, upstream: { url: `${endpoint}/v1/chat/completions` },
    auth: { enabled: true, url: endpoint },
    sessionInit: { enabled: true, debugForceIdentity: { team_id: "t", agent_id: "a" }, injectAgentContext: false, injectTaskContext: false },
    storage: { enabled: true, backend: "fs", fs: { fsRoot: join(directory, "proxy-state") } },
    skill: { endpoint, serviceToken: "fixture-gateway" }, creditReport: { url: `${endpoint}/credit`, timeoutMs: 500 },
    extraction: { enabled: true, extractors: ["tdai-memory"] },
    tdai: { enabled: true, endpoint, apiKey: "fixture-gateway", serviceId: "tenant",
      memory: { enabled: true, writeL0: true },
      piOutbox: { enabled: true, directory: join(directory, "outbox"), idempotencyContract: "1142" } },
  };
  const configPath = join(directory, "proxy.json"); await writeFile(configPath, JSON.stringify(configuration));
  async function startProxy() {
    const running = child(["--import", loader, join(proxy, "src/index.ts"), "--config", configPath]);
    try { await waitFor(async () => {
      if (running.process.exitCode !== null) throw new Error(`Proxy exited: ${running.output()}`);
      return fetch(`${proxyUrl}/health`).then(response => response.ok, () => false);
    }); } catch (error) { childLogs.push(running.output()); throw error; }
    return running;
  }
  let running = await startProxy();
  const piConfig = join(directory, "pi-config"); await mkdir(piConfig);
  await writeFile(join(piConfig, "models.json"), JSON.stringify({ providers: { tdai: { modelOverrides: {
    "glm-5.2-vision": { compat: { supportsDeveloperRole: false } },
  } } } }));
  async function runPi(prompt: string) {
    const invocation = child(["--import", pathToFileURL(join(pi, "packages/coding-agent/src/experimental/source-resolver.ts")).href,
      join(pi, "packages/coding-agent/src/experimental/cli.ts"), "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
      "-e", resolve(proxy, "../MemoryCore/pi-plugin"), "--provider", "tdai", "--model", "glm-5.2-vision", "--thinking", "off", "--tools", "read", "--mode", "json", "-p", prompt],
    { PI_CODING_AGENT_DIR: piConfig, TDAI_PROXY_URL: proxyUrl, TDAI_USER_KEY: "fixture-user", TDAI_TEAM_ID: "t", TDAI_AGENT_ID: "a", TDAI_SPACE_ID: "tenant" });
    const timer = setTimeout(() => { void kill(invocation.process); }, 60_000);
    const result = await invocation.exit; clearTimeout(timer);
    childLogs.push(invocation.output()); assert.deepEqual(result, [0, null], invocation.output());
    return invocation.output();
  }
  assert((await runPi("Reply with PI_OUTBOX_OK")).includes("PI_OUTBOX_OK"));
  assert((await runPi(`outbox-read: Read ${fixtureFile} and report its contents.`)).includes(marker));
  assert(toolObserved, "Real Pi must execute the read tool and send its result back");
  await waitFor(async () => (await queue.inspect()).entries.length === 0);
  assert.equal(deliveries.length, 3, "one normal response plus two tool-loop model responses");
  async function request(session: string, key = "fixture-user") {
    return fetch(`${proxyUrl}/pi/tenant/v1/chat/completions`, { method: "POST", headers: {
      authorization: `Bearer ${key}`, "content-type": "application/json", "x-conversation-id": session,
      "x-team-id": "t", "x-agent-id": "a",
    }, body: JSON.stringify({ model: "glm-5.2-vision", stream: false, messages: [{ role: "user", content: "identical question" }] }) });
  }
  assert.equal((await request("reject", "bad-key")).status, 401);
  for (let i = 0; i < 2; i++) assert.equal((await request("same-session")).status, 200);
  await waitFor(async () => (await queue.inspect()).entries.length === 0);
  assert.equal(new Set(deliveries.map(item => item.key)).size, 5);

  // Successful local capture during a gateway outage; real process death and recovery.
  gatewayDown = true;
  assert.equal((await request("restart-session")).status, 200);
  await waitFor(async () => (await queue.inspect()).entries.some(entry => entry.state === "pending" && entry.attempts >= 1));
  assert.equal((await queue.inspect()).entries.length, 1);
  await kill(running.process); childLogs.push(running.output());
  gatewayDown = false; dropReply = true;
  running = await startProxy();
  await waitFor(() => deliveries.length === 6);
  const committed = deliveries.at(-1)!;
  assert.equal((await queue.inspect()).entries[0].state, "leased");
  await kill(running.process); childLogs.push(running.output());
  dropReply = false;
  running = await startProxy();
  await waitFor(async () => deliveries.length === 7 && (await queue.inspect()).entries.length === 0, 45_000);
  assert.equal(deliveries.length, 7);
  assert.deepEqual(deliveries.at(-1), committed);
  const observer = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const count = (table: string) => Number(observer.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count);
    assert.equal(count("l0_conversations"), 12);
    assert.equal(count("conversation_add_receipts"), 6);
    assert.equal([...notifications.values()].reduce((a, b) => a + b, 0), 6);
  } finally { observer.close(); }
  console.log(JSON.stringify({ passed: true, realPi: true, actualProxyEntrypoint: true, modelCalls,
    logicalOperations: 6, gatewayAttemptsAfterCommit: 7, l0Rows: 12, receipts: 6, pipelineNotifications: 6,
    readToolExecuted: toolObserved, gatewayOutageRecovery: true, proxyKillAfterCommitReplay: true }));
} catch (error) {
  console.error([...childLogs, ...liveLogs.map(read => read().slice(-6000))].join("\n").slice(-40_000)); throw error;
} finally {
  for (const process of children) await kill(process);
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  store.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
