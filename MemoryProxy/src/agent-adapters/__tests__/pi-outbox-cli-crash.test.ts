import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiOutboxStore, type PiOutboxInput } from "../pi-outbox-store.js";

const cleanups: (() => Promise<void>)[] = [];
const allowedStderr = /^(?:\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?$/;
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface CliEvent { event: string; delivered?: number }
function startCli(directory: string, endpoint: string) {
  // Spawn the shipping entry point, with its default lease, clock and sender.
  // No test wrapper, fake timers or changes to the persisted filenames.
  const child = spawn(process.execPath,
    ["--import", "tsx/esm", "src/agent-adapters/pi-outbox-cli.ts", "run", directory, "--poll-ms", "100"],
    { cwd: process.cwd(), env: { ...process.env, TDAI_OUTBOX_ENDPOINT: endpoint,
      TDAI_OUTBOX_API_KEY: "cli-crash-test-key", TDAI_OUTBOX_IDEMPOTENCY: "1142" },
    stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  const events: CliEvent[] = [];
  let buffered = "";
  let stderr = "";
  child.stdout.on("data", chunk => {
    buffered += chunk.toString();
    const lines = buffered.split("\n");
    buffered = lines.pop()!;
    for (const line of lines) if (line.trim()) events.push(JSON.parse(line));
  });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  };
  cleanups.push(kill);
  return { child, events, exited, kill, stderr: () => stderr };
}

describe("Pi outbox run command crash recovery", () => {
  it("recovers the same queue after SIGKILL without replaying an unexpired lease or changing the request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-cli-crash-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const store = new PiOutboxStore(directory);
    const input: PiOutboxInput = {
      scope: { serviceId: "service", teamId: "team", agentId: "agent", userId: "user", sessionId: "session" },
      body: JSON.stringify({ session_id: "session", idempotency_key: "stable-cli-crash-turn",
        messages: [{ role: "user", content: "Preserve this turn across a real CLI process restart." }] }),
    };
    const original = await store.enqueue(input);
    const requests: { body: string; headers: IncomingHttpHeaders; at: number; response: ServerResponse }[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({ body: Buffer.concat(chunks).toString(), headers: request.headers, at: Date.now(), response });
      // Hold both receipts. The parent kills the first process and verifies the
      // new process's persisted attempt before allowing its ACK to complete.
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(async () => {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test gateway port");
    const endpoint = `http://127.0.0.1:${address.port}`;

    const first = startCli(directory, endpoint);
    await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 10_000, interval: 50 });
    const lease = (await store.inspect()).entries[0];
    expect(lease).toMatchObject({ id: original.id, state: "leased", attempts: 1 });
    expect(lease.availableAt).toBeGreaterThan(Date.now());
    expect(first.child.kill("SIGKILL")).toBe(true);
    await first.exited;
    expect(first.events.some(event => event.event === "stopped")).toBe(false);
    expect(first.stderr()).toMatch(allowedStderr);

    const reopened = new PiOutboxStore(directory);
    expect((await reopened.inspect()).entries).toEqual([lease]);
    expect(JSON.parse(await readFile(join(directory, lease.file), "utf8"))).toEqual(original);
    expect((await reopened.recover()).records).toEqual([]);

    const restarted = startCli(directory, endpoint);
    expect(restarted.child.pid).not.toBe(first.child.pid);
    await vi.waitFor(() => expect(restarted.events.some(event => event.event === "started")).toBe(true),
      { timeout: 10_000, interval: 50 });
    expect(requests).toHaveLength(1);
    expect((await reopened.inspect()).entries).toEqual([lease]);

    // Wait for the production 30-second lease to expire on the real clock.
    // Do not advance a test clock or edit the queue to make recovery immediate.
    await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 35_000, interval: 100 });
    expect(requests[1].at).toBeGreaterThanOrEqual(lease.availableAt);
    expect(requests.map(request => request.body)).toEqual([original.body, original.body]);
    for (const request of requests) {
      expect(request.headers).toMatchObject({ authorization: "Bearer cli-crash-test-key",
        "x-tdai-service-id": input.scope.serviceId, "x-tdai-team-id": input.scope.teamId,
        "x-tdai-agent-id": input.scope.agentId, "x-tdai-user-id": input.scope.userId,
        "x-tdai-session-id": input.scope.sessionId });
    }
    const replayLease = (await reopened.inspect()).entries[0];
    expect(replayLease).toMatchObject({ id: original.id, state: "leased", attempts: 2 });
    expect(JSON.parse(await readFile(join(directory, replayLease.file), "utf8"))).toEqual(original);

    requests[1].response.writeHead(202, { "content-type": "application/json" });
    requests[1].response.end(JSON.stringify({ code: 0, data: { accepted_ids: ["message-1"], total_count: 1 } }));
    await vi.waitFor(() => expect(restarted.events.some(event => event.delivered === 1)).toBe(true),
      { timeout: 5_000, interval: 50 });
    expect(await reopened.inspect()).toEqual({ entries: [], unreadable: [] });
    expect(requests).toHaveLength(2);
    expect(restarted.stderr()).toMatch(allowedStderr);
    // Once durable ACK has removed the record, another abrupt exit and reopen
    // must not resurrect it. Graceful POSIX signals are tested separately.
    await restarted.kill();
    expect((await new PiOutboxStore(directory).recover()).records).toEqual([]);
  }, 65_000);
});
