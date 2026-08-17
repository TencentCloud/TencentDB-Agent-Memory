import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Real cross-process coverage for the file outbox. The state machine is
 * already exercised in outbox.test.ts, but that runs everything in one
 * process, so the per-process `activeFlushes` map masks the lease race. These
 * tests spawn independent OS processes (plain `node` with type stripping) so
 * the atomic-rename lease and crash recovery run across real process
 * boundaries.
 */
const here = dirname(fileURLToPath(import.meta.url));
const childPath = join(here, "fixtures", "outbox-child.ts");
const dirs: string[] = [];

interface ChildResult {
  code: number;
  stdout: string;
}

/**
 * Spawn a child and return its handle so a test can hard-kill it mid-run (the
 * crash-recovery path) while still awaiting its eventual exit via `done`.
 */
function spawnChild(args: string[], timeoutMs = 30_000): { child: ChildProcess; done: Promise<ChildResult> } {
  const child = spawn(process.execPath, [childPath, ...args], {
    cwd: join(here, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const done = new Promise<ChildResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`child timed out; stdout=${stdout} stderr=${stderr}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`child exited ${code}: ${stderr || stdout}`));
      else resolve({ code, stdout });
    });
  });
  return { child, done };
}

function runChild(args: string[], timeoutMs = 30_000): Promise<ChildResult> {
  return spawnChild(args, timeoutMs).done;
}

async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function waitForFiles(files: string[], timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const present = await Promise.all(files.map((file) => access(file).then(() => true, () => false)));
    if (present.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${files.join(", ")}`);
}

async function waitForLease(directory: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const names = await readdir(directory);
    if (names.some((name) => name.includes(".json.lease-"))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for a lease in ${directory}`);
}

function startDeliveryServer(): Promise<{
  url: string;
  deliveries: Array<{ id: string; sessionId: string }>;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const deliveries: Array<{ id: string; sessionId: string }> = [];
    const server = createServer((request, response) => {
      let data = "";
      request.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      request.on("end", () => {
        try {
          deliveries.push(JSON.parse(data) as { id: string; sessionId: string });
        } catch {
          // Malformed payload: do not record it.
        }
        response.writeHead(200);
        response.end("ok");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        deliveries,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

function flushResult(stdout: string): { delivered: number; pending: number; invalid: number; dead: number } {
  const match = /FLUSH (\{.*\})/.exec(stdout);
  if (!match) throw new Error(`no FLUSH result in stdout: ${stdout}`);
  return JSON.parse(match[1] ?? "{}") as { delivered: number; pending: number; invalid: number; dead: number };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("cross-process capture outbox", () => {
  it("recovers a capture written by a process that exited before flushing", async () => {
    const outboxDir = await tmpDir("tdai-outbox-recover-");
    // The "writer" enqueues and exits without draining: exactly the window
    // where Pi dies after the capture is durable but before it is sent.
    const enqueued = await runChild(["enqueue", outboxDir, "pi-session-a"]);
    const id = /ENQUEUED (\S+)/.exec(enqueued.stdout)?.[1];
    expect(id).toBeTruthy();

    const server = await startDeliveryServer();
    try {
      const flushed = await runChild(["flush", outboxDir, server.url]);
      expect(flushResult(flushed.stdout)).toEqual({ delivered: 1, pending: 0, invalid: 0, dead: 0 });
      expect(server.deliveries).toEqual([{ id, sessionId: "pi-session-a" }]);
    } finally {
      await server.close();
    }
    const remaining = await readdir(outboxDir);
    expect(remaining).not.toEqual(expect.arrayContaining([expect.stringMatching(/\.json(\.|$)/)]));
  }, 20_000);

  it("delivers a record exactly once when two independent processes flush concurrently", async () => {
    const outboxDir = await tmpDir("tdai-outbox-race-");
    const gate = await tmpDir("tdai-outbox-gate-");
    await runChild(["enqueue", outboxDir, "pi-race"]);
    const readyOne = join(gate, "ready-1");
    const readyTwo = join(gate, "ready-2");
    const go = join(gate, "go");

    const server = await startDeliveryServer();
    try {
      // Both flushers are real processes; the gate makes them wait until both
      // are armed so the atomic-rename lease actually races.
      const first = runChild(["flush", outboxDir, server.url, "--ready", readyOne, "--wait-for", go]);
      const second = runChild(["flush", outboxDir, server.url, "--ready", readyTwo, "--wait-for", go]);
      await waitForFiles([readyOne, readyTwo]);
      await writeFile(go, "go");
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(server.deliveries).toHaveLength(1);
      const delivered = flushResult(firstResult.stdout).delivered + flushResult(secondResult.stdout).delivered;
      expect(delivered).toBe(1);
      expect(await readdir(outboxDir)).toEqual([]);
    } finally {
      await server.close();
    }
  }, 20_000);

  it("does not reclaim a lease another process is actively delivering because the record was enqueued long ago", async () => {
    const outboxDir = await tmpDir("tdai-outbox-stale-lease-");
    const gate = await tmpDir("tdai-outbox-stale-lease-gate-");
    const readyA = join(gate, "ready-a");
    const releaseA = join(gate, "release-a");

    // Enqueue a record, then age its mtime well past the lease timeout.
    // rename() preserves mtime, so a claim starts from that stale timestamp
    // and, without the fix, looks immediately reclaimable to a concurrent
    // flusher even though another process is mid-delivery.
    await runChild(["enqueue", outboxDir, "pi-lease"]);
    const recordFile = (await readdir(outboxDir)).find((name) => name.endsWith(".json"));
    expect(recordFile).toBeDefined();
    const ancient = new Date(Date.now() - 120_000);
    await utimes(join(outboxDir, recordFile as string), ancient, ancient);

    const server = await startDeliveryServer();
    try {
      // A claims the record and blocks inside deliver, holding the lease so B
      // can observe it. B flushes only after A's lease is on disk, then A is
      // released only after B has finished its reclaim pass.
      const first = runChild(["flush", outboxDir, server.url, "--ready", readyA, "--deliver-gate", releaseA]);
      await waitForFiles([readyA]);
      await waitForLease(outboxDir);

      const second = runChild(["flush", outboxDir, server.url]);
      const secondResult = await second;
      await writeFile(releaseA, "go");
      const firstResult = await first;

      expect(server.deliveries).toHaveLength(1);
      const delivered = flushResult(firstResult.stdout).delivered + flushResult(secondResult.stdout).delivered;
      expect(delivered).toBe(1);
    } finally {
      await server.close();
    }
  }, 20_000);

  it("does not reclaim a lease a delivery holds longer than the lease timeout", async () => {
    const outboxDir = await tmpDir("tdai-outbox-long-delivery-");
    const gate = await tmpDir("tdai-outbox-long-delivery-gate-");
    const readyA = join(gate, "ready-a");
    const releaseA = join(gate, "release-a");

    await runChild(["enqueue", outboxDir, "pi-long"]);
    const server = await startDeliveryServer();
    try {
      // A claims the record and blocks inside deliver. With a 300ms lease
      // timeout, A's claim stamp goes stale after 300ms - the only thing still
      // protecting the lease is the delivery heartbeat renewing its mtime. B
      // flushes after that point, so it must NOT reclaim A's live lease.
      const first = runChild(["flush", outboxDir, server.url, "--ready", readyA, "--deliver-gate", releaseA, "--lease-timeout", "300"]);
      await waitForFiles([readyA]);
      await waitForLease(outboxDir);
      await new Promise((resolve) => setTimeout(resolve, 450));

      const second = runChild(["flush", outboxDir, server.url, "--lease-timeout", "300"]);
      const secondResult = await second;
      await writeFile(releaseA, "go");
      const firstResult = await first;

      expect(server.deliveries).toHaveLength(1);
      expect(flushResult(secondResult.stdout).delivered).toBe(0);
      const delivered = flushResult(firstResult.stdout).delivered + flushResult(secondResult.stdout).delivered;
      expect(delivered).toBe(1);
    } finally {
      await server.close();
    }
  }, 20_000);

  it("reclaims and delivers a record whose holder was hard-killed mid-delivery once its lease expires", async () => {
    const outboxDir = await tmpDir("tdai-outbox-kill-");
    const gate = await tmpDir("tdai-outbox-kill-gate-");
    const readyA = join(gate, "ready-a");
    const blockedA = join(gate, "blocked-in-deliver"); // A is killed, never released

    await runChild(["enqueue", outboxDir, "pi-killed"]);

    const server = await startDeliveryServer();
    try {
      // A claims the record and blocks inside deliver, holding the lease. It is
      // then hard-killed (not released through the gate), so the lease stays on
      // disk with no further heartbeats. B starts only after the lease has gone
      // stale, reclaims the record, and delivers it exactly once.
      const first = spawnChild([
        "flush", outboxDir, server.url,
        "--ready", readyA, "--deliver-gate", blockedA, "--lease-timeout", "300",
      ]);
      await waitForFiles([readyA]);
      await waitForLease(outboxDir);

      // Kill the process mid-delivery and wait for it to actually die.
      first.child.kill();
      await first.done.catch(() => {});

      // The claim stamp (embedded in the lease filename) and the last heartbeat
      // mtime are both stale now; B must reclaim the orphaned lease.
      await new Promise((resolve) => setTimeout(resolve, 450));

      const second = await runChild(["flush", outboxDir, server.url, "--lease-timeout", "300"]);
      expect(flushResult(second.stdout).delivered).toBe(1);
      expect(server.deliveries).toHaveLength(1);
      expect(server.deliveries[0]?.sessionId).toBe("pi-killed");
      expect(await readdir(outboxDir)).toEqual([]);
    } finally {
      await server.close();
    }
  }, 20_000);

  it("ignores a half-written temp file left by a crashed writer", async () => {
    const outboxDir = await tmpDir("tdai-outbox-tmp-");
    await runChild(["enqueue", outboxDir, "pi-tmp"]);
    // A crash inside writeRecord leaves an orphan *.tmp holding partial JSON.
    await writeFile(join(outboxDir, "crash.json.12345.orphan.tmp"), '{"version":1,');

    const server = await startDeliveryServer();
    try {
      const flushed = await runChild(["flush", outboxDir, server.url]);
      const result = flushResult(flushed.stdout);
      expect(result.invalid).toBe(0);
      expect(result.delivered).toBe(1);
      expect(server.deliveries).toHaveLength(1);
    } finally {
      await server.close();
    }
  }, 20_000);
});
