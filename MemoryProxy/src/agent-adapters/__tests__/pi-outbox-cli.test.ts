import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiOutboxStore, type PiOutboxInput } from "../pi-outbox-store.js";
import { runPiOutboxCommand } from "../pi-outbox-cli.js";

const cleanups: (() => Promise<void>)[] = [];
interface CommandEvent {
  event: string;
  delivered?: number;
  retried?: number;
  dead?: number;
  errors?: string[];
  unreadable?: { file: string; reason: string }[];
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "pi-cli-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function input(key = "turn-1"): PiOutboxInput {
  return { scope: { serviceId: "s", teamId: "t", agentId: "a", userId: "u", sessionId: "session" },
    body: JSON.stringify({ session_id: "session", idempotency_key: key,
      messages: [{ role: "user", content: "private CLI conversation" }] }) };
}
async function gateway(handler: (body: string, response: ServerResponse, request: IncomingMessage) => void) {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    handler(Buffer.concat(chunks).toString(), response, request);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => closeServer(server));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test gateway port");
  return { TDAI_OUTBOX_ENDPOINT: `http://127.0.0.1:${address.port}`,
    TDAI_OUTBOX_API_KEY: "private-cli-key", TDAI_OUTBOX_IDEMPOTENCY: "1142" };
}
async function closeServer(server: Server) {
  const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}
function receipt(response: ServerResponse) {
  response.writeHead(202, { "content-type": "application/json" });
  response.end(JSON.stringify({ code: 0, data: { accepted_ids: ["message-1"], total_count: 1 } }));
}
async function run(dir: string, env: NodeJS.ProcessEnv,
  onEvent: (event: CommandEvent, stop: () => void) => void = () => {}) {
  const controller = new AbortController();
  const events: CommandEvent[] = [];
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const code = await runPiOutboxCommand(["run", dir, "--poll-ms", "20"], env, line => {
      const event = JSON.parse(line);
      events.push(event);
      onEvent(event, () => controller.abort());
    }, controller.signal);
    return { code, events };
  } finally { clearTimeout(timeout); controller.abort(); }
}

describe("Pi outbox continuous command", () => {
  it("discovers records enqueued after starting with an empty queue and omits idle pass logs", async () => {
    const dir = await directory();
    const store = new PiOutboxStore(dir);
    const env = await gateway((_, response) => receipt(response));
    const enqueue = setTimeout(() => { void store.enqueue(input()); }, 100);
    try {
      const result = await run(dir, env, (event, stop) => { if (event.delivered === 1) stop(); });
      expect(result.code).toBe(0);
      expect(result.events.map(event => event.event)).toEqual(["started", "pass", "stopped"]);
      expect(result.events.at(-1)).toMatchObject({ pending: 0, leased: 0, dead: 0 });
      expect(JSON.stringify(result)).not.toContain("private");
    } finally { clearTimeout(enqueue); }
  });

  it("automatically retries a server failure with the same bytes after the persisted backoff", async () => {
    const dir = await directory();
    const store = new PiOutboxStore(dir);
    const original = await store.enqueue(input());
    const requests: { body: string; at: number }[] = [];
    let availableAt = 0;
    const env = await gateway((body, response) => {
      requests.push({ body, at: Date.now() });
      if (requests.length === 1) { response.writeHead(503); response.end(); }
      else receipt(response);
    });
    const result = await run(dir, env, (event, stop) => {
      if (event.retried) {
        // The first retry is scheduled a second later; polling must not bypass it.
        availableAt = requests[0].at + 1_000;
      }
      if (event.delivered) stop();
    });
    expect(result.code).toBe(0);
    expect(requests.map(request => request.body)).toEqual([original.body, original.body]);
    expect(requests[1].at).toBeGreaterThanOrEqual(availableAt);
    expect(result.events.some(event => event.retried === 1)).toBe(true);
    expect((await store.inspect()).entries).toEqual([]);
  });

  it("keeps running after a conflict and sends an operator-redriven record without changing its key", async () => {
    const dir = await directory();
    const store = new PiOutboxStore(dir);
    const original = await store.enqueue(input());
    const requests: string[] = [];
    const env = await gateway((body, response) => {
      requests.push(body);
      if (requests.length === 1) { response.writeHead(409); response.end(); }
      else receipt(response);
    });
    let redrive: Promise<number> | undefined;
    const result = await run(dir, env, (event, stop) => {
      if (event.dead) redrive = runPiOutboxCommand(["redrive", dir, original.id], {}, () => {});
      if (event.delivered) stop();
    });
    expect(await redrive).toBe(0);
    expect(result.code).toBe(0);
    expect(requests).toEqual([original.body, original.body]);
  });

  it("cancels an in-flight HTTP request on stop and leaves its exact record pending for restart", async () => {
    const dir = await directory();
    const store = new PiOutboxStore(dir);
    const original = await store.enqueue(input());
    const controller = new AbortController();
    let requests = 0;
    const env = await gateway(() => { requests++; controller.abort(); });
    const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const events: CommandEvent[] = [];
    expect(await runPiOutboxCommand(["run", dir], env, line => events.push(JSON.parse(line)), controller.signal)).toBe(0);
    expect(requests).toBe(1);
    expect(events.at(-1)).toMatchObject({ event: "stopped", pending: 1, leased: 0 });
    expect((await store.inspect()).entries[0]).toMatchObject({ id: original.id, attempts: 1, state: "pending" });
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
    // Recovering later retains the same bytes, not a newly generated request.
    const future = new PiOutboxStore(dir, () => Date.now() + 10_000);
    expect((await future.recover()).records[0].body).toBe(original.body);
  });

  it("reports retained dead and damaged records at shutdown without exposing their contents", async () => {
    const dir = await directory();
    const store = new PiOutboxStore(dir);
    await store.enqueue(input());
    await writeFile(join(dir, "00000000-0000-0000-0000-000000000000.json"), "private corrupted data");
    const env = await gateway((_, response) => { response.writeHead(401); response.end(); });
    const result = await run(dir, env, (event, stop) => { if (event.dead) stop(); });
    expect(result.code).toBe(2);
    expect(result.events.at(-1)).toMatchObject({ event: "stopped", dead: 1, leased: 0 });
    expect(result.events.at(-1)?.unreadable).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("reports a failed local ACK at shutdown and preserves the leased record", async () => {
    const dir = await directory();
    const store = new PiOutboxStore(dir);
    const original = await store.enqueue(input());
    const env = await gateway((_, response) => receipt(response));
    vi.spyOn(PiOutboxStore.prototype, "acknowledge").mockRejectedValue(new Error("private local I/O error"));
    const result = await run(dir, env, (event, stop) => { if (event.errors?.length) stop(); });
    expect(result.code).toBe(2);
    expect(result.events.at(-1)).toMatchObject({ event: "stopped", leased: 1, errors: [original.id] });
    expect((await store.inspect()).entries[0].id).toBe(original.id);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("validates run options and the gateway contract before starting, and cleans up on local I/O failure", async () => {
    const dir = await directory();
    for (const args of [["run", dir, "--poll-ms", "0"], ["run", dir, "--poll-ms", "1.5"],
      ["run", dir, "--poll-ms", "86400001"], ["run", dir, "--poll-ms"], ["flush", dir, "--poll-ms", "20"]]) {
      await expect(runPiOutboxCommand(args, {}, () => {})).rejects.toThrow();
    }
    await expect(runPiOutboxCommand(["run", dir], {}, () => {})).rejects.toThrow("verified compatible gateway");
    const file = join(dir, "not-a-directory");
    await writeFile(file, "");
    const env = await gateway((_, response) => receipt(response));
    const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    await expect(runPiOutboxCommand(["run", file], env, () => {})).rejects.toThrow();
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
  });

  it.skipIf(process.platform === "win32").each(["SIGINT", "SIGTERM"] as const)("stops the actual CLI process gracefully on %s", async signal => {
    const dir = await directory();
    const env = await gateway((_, response) => receipt(response));
    const child = spawn(process.execPath, ["--import", "tsx/esm", "src/agent-adapters/pi-outbox-cli.ts", "run", dir],
      { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit");
    cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } });
    let stdout = "";
    let stderr = "";
    let stopping = false;
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (!stopping && stdout.includes('"started"')) { stopping = true; child.kill(signal); }
    });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      expect(await exited).toEqual([0, null]);
      expect(stdout).toContain('"stopped"');
      expect(stderr).toBe("");
    } finally { clearTimeout(timeout); }
  });
});
