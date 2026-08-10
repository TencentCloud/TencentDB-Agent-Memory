/**
 * tz-01 criterion 5 (`single-writer-per-role`) across PROCESSES.
 *
 * Two real child processes build their own ConsolidationOrchestrator on one
 * shared dataDir and call `runNow` for a role. The probe deliberately goes
 * through the trigger path rather than through acquireRoleLock: the gap this
 * criterion closes is that the in-process gate never saw a second process.
 *
 * Sequencing is by files, not by timers: the first worker signals `.ready`
 * once its (mocked) child is running and holds there until the barrier file
 * is deleted.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("./role-lock.worker.ts", import.meta.url));
const isBun = (globalThis as { Bun?: unknown }).Bun !== undefined;

let tmp: string;
let dataDir: string;
let roleDir: string;
let barrier: string;
const children: ChildProcessWithoutNullStreams[] = [];

function startWorker(role: string): {
  child: ChildProcessWithoutNullStreams;
  done: Promise<string>;
} {
  const args = isBun
    ? [WORKER, dataDir, roleDir, role, barrier]
    : ["--import", "tsx", WORKER, dataDir, roleDir, role, barrier];
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  let err = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr.on("data", (d: Buffer) => (err += d.toString()));
  const done = new Promise<string>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      const m = /RESULT (\S+)(.*)/.exec(out);
      // A refused run is a failed summary carrying the single-flight error.
      if (m)
        return resolve((m[2] ?? "").includes("single-flight") ? "busy" : m[1]!);
      reject(new Error(`worker(${role}) exit=${code} out=${out} err=${err}`));
    });
  });
  // A worker killed in afterEach must not surface as an unhandled rejection.
  done.catch(() => undefined);
  return { child, done };
}

/** Wait until a worker reports that its run is in flight. */
async function waitReady(role: string, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fs.existsSync(`${barrier}.${role}.ready`)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`worker for ${role} never started its run`);
}

function writeRole(role: string, scope: string): void {
  const dir = path.join(roleDir, role);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "role.json"),
    JSON.stringify({ name: role, scope, max_run_ms: 600_000 }),
    "utf-8",
  );
  fs.writeFileSync(path.join(dir, "prompt.md"), `PROMPT ${role}`, "utf-8");
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-lock-"));
  dataDir = path.join(tmp, "data");
  roleDir = path.join(tmp, "roles");
  barrier = path.join(tmp, "barrier");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(barrier, "hold", "utf-8");
  writeRole("role-one", "fresh_tail");
  writeRole("role-two", "fresh_tail");
});

afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("single-writer-per-role across processes", () => {
  it("same role in two processes → one runs, the other is refused", async () => {
    const first = startWorker("role-one");
    await waitReady("role-one");

    const second = startWorker("role-one");
    // The second process must refuse WITHOUT waiting for the first to finish.
    const secondStatus = await second.done;
    expect(secondStatus).toBe("busy");

    fs.rmSync(barrier, { force: true }); // let the first run finish
    expect(await first.done).toBe("ok");
  }, 60_000);

  it("different roles in two processes → both run", async () => {
    const one = startWorker("role-one");
    const two = startWorker("role-two");
    await waitReady("role-one");
    await waitReady("role-two");

    fs.rmSync(barrier, { force: true });
    expect(await one.done).toBe("ok");
    expect(await two.done).toBe("ok");
  }, 60_000);
});
