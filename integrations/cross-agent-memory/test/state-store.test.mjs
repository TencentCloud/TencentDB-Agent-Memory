import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, readdir, rename as fsRename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  drainCaptureQueue,
  enqueueCapture,
  makeMemorySessionId,
  savePendingTurn,
  takePendingTurn
} from "../src/state-store.mjs";

const adapterDir = resolve(import.meta.dirname, "..");
const stateStoreUrl = pathToFileURL(join(adapterDir, "src", "state-store.mjs")).href;

async function withRuntime(run) {
  const runtimeRoot = join(adapterDir, "runtime");
  await mkdir(runtimeRoot, { recursive: true });
  const runtimeDir = await mkdtemp(join(runtimeRoot, "test-"));
  try {
    await run(runtimeDir);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

function captureRecord(content, timestamp = "2026-08-08T00:00:00.000Z") {
  return {
    memorySessionId: "codex-0123456789abcdef01234567",
    messages: [
      { role: "user", content, timestamp },
      { role: "assistant", content: `reply:${content}`, timestamp: "2026-08-08T00:00:01.000Z" }
    ]
  };
}

function storedCaptureRecord(content) {
  const record = { ...captureRecord(content), queuedAt: "2026-08-08T00:00:02.000Z" };
  return {
    ...record,
    digest: createHash("sha256").update(JSON.stringify({
      memorySessionId: record.memorySessionId,
      messages: record.messages
    }), "utf8").digest("hex")
  };
}

function runChild(script, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(stderr || `child exited ${code}`)));
  });
}

test("pending turns are isolated by client, use digest-only filenames, and are consumed once", async () => {
  await withRuntime(async (runtimeDir) => {
    const sourceSessionId = "shared session / 用户";
    const prompt = "原始 prompt with spaces";
    for (const client of ["codex", "claude", "zcode"]) {
      await savePendingTurn({ client, sourceSessionId, prompt: `${client}:${prompt}`, skip: false, submittedAt: "2026-08-08T00:00:00.000Z" }, { runtimeDir });
    }

    const names = await readdir(join(runtimeDir, "pending"));
    assert.equal(names.length, 3);
    for (const name of names) {
      assert.match(name, /^[a-f0-9]{64}\.json$/);
      assert.equal(name.includes("shared"), false);
      assert.equal(name.includes("prompt"), false);
    }

    for (const client of ["codex", "claude", "zcode"]) {
      const pending = await takePendingTurn({ client, sourceSessionId }, { runtimeDir });
      assert.deepEqual(pending, {
        client,
        prompt: `${client}:${prompt}`,
        skip: false,
        submittedAt: "2026-08-08T00:00:00.000Z"
      });
      assert.equal(await takePendingTurn({ client, sourceSessionId }, { runtimeDir }), null);
    }
  });
});

test("a non-consuming pending read supports repeated Stop and is overwritten only by the next matching submit", async () => {
  await withRuntime(async (runtimeDir) => {
    const key = { client: "codex", sourceSessionId: "continued-session" };
    await savePendingTurn({
      ...key,
      prompt: "continued prompt",
      skip: false,
      submittedAt: "2026-08-08T00:00:00.000Z"
    }, { runtimeDir });

    assert.equal((await takePendingTurn(key, { runtimeDir, consume: false })).prompt, "continued prompt");
    assert.equal((await takePendingTurn(key, { runtimeDir, consume: false })).prompt, "continued prompt");
    assert.equal(await takePendingTurn({
      client: "codex",
      sourceSessionId: "different-session"
    }, { runtimeDir, consume: false }), null);

    await savePendingTurn({
      ...key,
      prompt: "next prompt",
      skip: false,
      submittedAt: "2026-08-08T00:01:00.000Z"
    }, { runtimeDir });
    assert.equal((await takePendingTurn(key, { runtimeDir, consume: false })).prompt, "next prompt");
  });
});

test("a caller deadline bounds pending-lock contention", async () => {
  await withRuntime(async (runtimeDir) => {
    const key = { client: "codex", sourceSessionId: "deadline-pending" };
    await savePendingTurn({
      ...key,
      prompt: "deadline prompt",
      skip: false,
      submittedAt: "2026-08-08T00:00:00.000Z"
    }, { runtimeDir });
    const [canonical] = (await readdir(join(runtimeDir, "pending")))
      .filter((name) => name.endsWith(".json"));
    await mkdir(join(runtimeDir, "pending", `${canonical.slice(0, -5)}.pending-lock`));

    const started = Date.now();
    assert.equal(await takePendingTurn(key, {
      runtimeDir,
      consume: false,
      deadline: Date.now() + 50
    }), null);
    assert.ok(Date.now() - started < 250);
  });
});

test("a caller deadline bounds queue-lock contention after the current capture is durable", async () => {
  await withRuntime(async (runtimeDir) => {
    await mkdir(join(runtimeDir, "capture-queue.lock"));
    const started = Date.now();
    assert.equal(await enqueueCapture(captureRecord("deadline queue"), {
      runtimeDir,
      deadline: Date.now() + 50
    }), true);
    assert.ok(Date.now() - started < 250);
    const spoolNames = await readdir(join(runtimeDir, "capture-spool"));
    assert.equal(spoolNames.length, 1);
    assert.match(await readFile(join(runtimeDir, "capture-spool", spoolNames[0]), "utf8"), /deadline queue/);
  });
});

test("a caller deadline bounds retry queue-lock contention", async () => {
  await withRuntime(async (runtimeDir) => {
    await mkdir(join(runtimeDir, "capture-queue.lock"));
    const started = Date.now();
    assert.deepEqual(await drainCaptureQueue(3, async () => true, {
      runtimeDir,
      deadline: Date.now() + 50
    }), { processed: 0, removed: 0, remaining: 0, stopped: true });
    assert.ok(Date.now() - started < 250);
  });
});

test("makeMemorySessionId prefixes a normalized client and the first 24 SHA-256 hex characters", () => {
  const source = "用户原始 session id";
  const digest = createHash("sha256").update(source, "utf8").digest("hex").slice(0, 24);
  assert.equal(makeMemorySessionId("Codex", source), `codex-${digest}`);
  assert.equal(makeMemorySessionId("Claude", source), `claude-${digest}`);
  assert.notEqual(makeMemorySessionId("codex", source), makeMemorySessionId("zcode", source));
});

test("a later hook removes orphaned pending turns older than seven days", async () => {
  await withRuntime(async (runtimeDir) => {
    await savePendingTurn({ client: "codex", sourceSessionId: "old", prompt: "old prompt", skip: false, submittedAt: "2026-07-01T00:00:00.000Z" }, { runtimeDir });
    const [oldName] = await readdir(join(runtimeDir, "pending"));
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(join(runtimeDir, "pending", oldName), oldTime, oldTime);

    await savePendingTurn({ client: "codex", sourceSessionId: "new", prompt: "new prompt", skip: false, submittedAt: new Date().toISOString() }, { runtimeDir });

    assert.equal(await takePendingTurn({ client: "codex", sourceSessionId: "old" }, { runtimeDir }), null);
    assert.equal((await takePendingTurn({ client: "codex", sourceSessionId: "new" }, { runtimeDir })).prompt, "new prompt");
  });
});

test("takePendingTurn claims the old state before a concurrent save and cannot unlink the new state", async () => {
  await withRuntime(async (runtimeDir) => {
    const key = { client: "codex", sourceSessionId: "race" };
    await savePendingTurn({ ...key, prompt: "old", skip: false, submittedAt: "2026-08-08T00:00:00.000Z" }, { runtimeDir });
    let releaseClaim;
    const claimed = new Promise((resolveClaimed) => {
      releaseClaim = resolveClaimed;
    });
    let continueTake;
    const mayRead = new Promise((resolveRead) => { continueTake = resolveRead; });
    const take = takePendingTurn(key, {
      runtimeDir,
      fs: {
        rename: async (from, to) => {
          await fsRename(from, to);
          releaseClaim();
          await mayRead;
        }
      }
    });
    await claimed;
    const save = savePendingTurn({ ...key, prompt: "new", skip: false, submittedAt: "2026-08-08T00:00:01.000Z" }, { runtimeDir });
    const saveState = await Promise.race([
      save.then(() => "completed"),
      new Promise((resolveWait) => setTimeout(() => resolveWait("waiting"), 50))
    ]);
    continueTake();

    assert.equal((await take).prompt, "old");
    assert.equal(saveState, "waiting");
    assert.equal(await save, true);
    assert.equal((await takePendingTurn(key, { runtimeDir })).prompt, "new");
  });
});

test("orphan cleanup deletes only its stale claim and preserves a concurrently saved canonical state", async () => {
  await withRuntime(async (runtimeDir) => {
    const key = { client: "codex", sourceSessionId: "cleanup-race" };
    await savePendingTurn({ ...key, prompt: "old", skip: false, submittedAt: "2026-07-01T00:00:00.000Z" }, { runtimeDir });
    const [oldName] = await readdir(join(runtimeDir, "pending"));
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(join(runtimeDir, "pending", oldName), oldTime, oldTime);
    let releaseClaim;
    const claimed = new Promise((resolveClaimed) => { releaseClaim = resolveClaimed; });
    let continueCleanup;
    const mayClean = new Promise((resolveClean) => { continueCleanup = resolveClean; });
    const cleaningHook = savePendingTurn({
      client: "codex", sourceSessionId: "trigger", prompt: "trigger", skip: false, submittedAt: new Date().toISOString()
    }, {
      runtimeDir,
      fs: {
        rename: async (from, to) => {
          await fsRename(from, to);
          if (from.endsWith(oldName)) {
            releaseClaim();
            await mayClean;
          }
        }
      }
    });
    await claimed;
    const save = savePendingTurn({ ...key, prompt: "new", skip: false, submittedAt: new Date().toISOString() }, { runtimeDir });
    const saveState = await Promise.race([
      save.then(() => "completed"),
      new Promise((resolveWait) => setTimeout(() => resolveWait("waiting"), 50))
    ]);
    continueCleanup();
    await cleaningHook;

    assert.equal(saveState, "waiting");
    assert.equal(await save, true);
    assert.equal((await takePendingTurn(key, { runtimeDir })).prompt, "new");
  });
});

test("take waits on a cleanup claim and receives the fresh turn after cleanup restores it", async () => {
  await withRuntime(async (runtimeDir) => {
    const key = { client: "codex", sourceSessionId: "fresh-cleanup-gap" };
    await savePendingTurn({ ...key, prompt: "fresh", skip: false, submittedAt: new Date().toISOString() }, { runtimeDir });
    const [canonicalName] = (await readdir(join(runtimeDir, "pending"))).filter((name) => name.endsWith(".json"));
    const canonicalPath = join(runtimeDir, "pending", canonicalName);
    let releaseClaim;
    const claimed = new Promise((resolveClaimed) => { releaseClaim = resolveClaimed; });
    let continueCleanup;
    const mayRestore = new Promise((resolveRestore) => { continueCleanup = resolveRestore; });
    const cleaningHook = savePendingTurn({
      client: "codex", sourceSessionId: "fresh-trigger", prompt: "trigger", skip: false, submittedAt: new Date().toISOString()
    }, {
      runtimeDir,
      fs: {
        stat: async (path) => {
          const result = await stat(path);
          if (path === canonicalPath) return { ...result, mtimeMs: Date.now() - 8 * 24 * 60 * 60 * 1000 };
          if (path.endsWith(".cleanup-claim")) return { ...result, mtimeMs: Date.now() };
          return result;
        },
        rename: async (from, to) => {
          await fsRename(from, to);
          if (from === canonicalPath) {
            releaseClaim();
            await mayRestore;
          }
        }
      }
    });
    await claimed;
    const take = takePendingTurn(key, { runtimeDir });
    const takeState = await Promise.race([
      take.then(() => "completed"),
      new Promise((resolveWait) => setTimeout(() => resolveWait("waiting"), 50))
    ]);
    continueCleanup();

    await cleaningHook;
    assert.equal(takeState, "waiting");
    assert.equal((await take).prompt, "fresh");
  });
});

test("take restores its discoverable claim when reading the claimed state fails", async () => {
  await withRuntime(async (runtimeDir) => {
    const key = { client: "codex", sourceSessionId: "read-failure" };
    await savePendingTurn({ ...key, prompt: "recover me", skip: false, submittedAt: new Date().toISOString() }, { runtimeDir });

    assert.equal(await takePendingTurn(key, {
      runtimeDir,
      fs: { readFile: async () => { throw new Error("injected read failure"); } }
    }), null);

    assert.equal((await takePendingTurn(key, { runtimeDir })).prompt, "recover me");
  });
});

test("cleanup discovers an unrestored take claim and expires it after seven days", async () => {
  await withRuntime(async (runtimeDir) => {
    const key = { client: "codex", sourceSessionId: "expired-claim" };
    await savePendingTurn({ ...key, prompt: "old secret prompt", skip: false, submittedAt: new Date().toISOString() }, { runtimeDir });
    await takePendingTurn(key, {
      runtimeDir,
      fs: {
        readFile: async () => { throw new Error("injected read failure"); },
        link: async () => { throw new Error("injected restore failure"); }
      }
    });
    const pendingDir = join(runtimeDir, "pending");
    const claimName = (await readdir(pendingDir)).find((name) => name.endsWith(".take-claim"));
    assert.ok(claimName);
    const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(join(pendingDir, claimName), expired, expired);

    await savePendingTurn({
      client: "codex", sourceSessionId: "expiry-trigger", prompt: "trigger", skip: false, submittedAt: new Date().toISOString()
    }, { runtimeDir });

    assert.equal((await readdir(pendingDir)).some((name) => name.endsWith(".take-claim")), false);
    assert.equal(await takePendingTurn(key, { runtimeDir }), null);
  });
});

test("failed deletion quarantines an expired cleanup claim without restoring the stale canonical", async () => {
  await withRuntime(async (runtimeDir) => {
    const key = { client: "codex", sourceSessionId: "stale-delete-failure" };
    await savePendingTurn({ ...key, prompt: "stale prompt", skip: false, submittedAt: new Date().toISOString() }, { runtimeDir });
    const pendingDir = join(runtimeDir, "pending");
    const canonicalName = (await readdir(pendingDir)).find((name) => name.endsWith(".json"));
    const digest = canonicalName.slice(0, -5);
    const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(join(pendingDir, canonicalName), expired, expired);

    await savePendingTurn({
      client: "codex", sourceSessionId: "delete-failure-trigger", prompt: "trigger", skip: false, submittedAt: new Date().toISOString()
    }, {
      runtimeDir,
      fs: {
        unlink: async (path) => {
          if (path.endsWith(".cleanup-claim")) throw new Error("injected unlink failure");
          return rm(path);
        }
      }
    });

    let names = await readdir(pendingDir);
    assert.equal(names.includes(`${digest}.json`), false);
    assert.equal(names.some((name) => name.includes(digest) && name.endsWith(".cleanup-claim")), true);

    await savePendingTurn({
      client: "codex", sourceSessionId: "delete-retry-trigger", prompt: "trigger", skip: false, submittedAt: new Date().toISOString()
    }, { runtimeDir });
    names = await readdir(pendingDir);
    assert.equal(names.includes(`${digest}.json`), false);
    assert.equal(names.some((name) => name.includes(digest) && name.endsWith(".cleanup-claim")), false);
  });
});

test("global cleanup has one aggregate budget across many locked sessions without losing their content", async () => {
  await withRuntime(async (runtimeDir) => {
    const pendingDir = join(runtimeDir, "pending");
    await mkdir(pendingDir, { recursive: true });
    const locked = [];
    for (let index = 0; index < 5; index += 1) {
      const digest = createHash("sha256").update(`locked-${index}`, "utf8").digest("hex");
      const source = JSON.stringify({ client: "codex", prompt: `raw prompt ${index}`, skip: false, submittedAt: new Date().toISOString() });
      await writeFile(join(pendingDir, `${digest}.json`), source, "utf8");
      await mkdir(join(pendingDir, `${digest}.pending-lock`));
      locked.push({ digest, source });
    }

    const started = Date.now();
    assert.equal(await savePendingTurn({
      client: "codex", sourceSessionId: "budget-trigger", prompt: "trigger", skip: false, submittedAt: new Date().toISOString()
    }, { runtimeDir }), true);
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 500, `cleanup took ${elapsed}ms`);
    for (const { digest, source } of locked) {
      assert.equal(await readFile(join(pendingDir, `${digest}.json`), "utf8"), source);
    }
  });
});

test("cleanup removes only stale adapter-owned pending temps and preserves fresh or unrelated temps", async () => {
  await withRuntime(async (runtimeDir) => {
    const pendingDir = join(runtimeDir, "pending");
    await mkdir(pendingDir, { recursive: true });
    const digest = "b".repeat(64);
    const staleName = `${digest}.1234.00000000-0000-4000-8000-000000000001.tmp`;
    const freshName = `${digest}.1235.00000000-0000-4000-8000-000000000002.tmp`;
    const unrelatedName = `${digest}.not-a-pid.00000000-0000-4000-8000-000000000003.tmp`;
    await writeFile(join(pendingDir, staleName), "stale raw prompt", "utf8");
    await writeFile(join(pendingDir, freshName), "fresh raw prompt", "utf8");
    await writeFile(join(pendingDir, unrelatedName), "unrelated content", "utf8");
    const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(join(pendingDir, staleName), expired, expired);
    await utimes(join(pendingDir, unrelatedName), expired, expired);

    await savePendingTurn({
      client: "codex", sourceSessionId: "temp-cleanup-trigger", prompt: "trigger", skip: false, submittedAt: new Date().toISOString()
    }, { runtimeDir });

    await assert.rejects(() => access(join(pendingDir, staleName)));
    assert.equal(await readFile(join(pendingDir, freshName), "utf8"), "fresh raw prompt");
    assert.equal(await readFile(join(pendingDir, unrelatedName), "utf8"), "unrelated content");
    assert.equal((await readdir(pendingDir)).includes(`${digest}.json`), false);
  });
});

test("failed stale pending-temp deletion leaves it quarantined for the next cleanup", async () => {
  await withRuntime(async (runtimeDir) => {
    const pendingDir = join(runtimeDir, "pending");
    await mkdir(pendingDir, { recursive: true });
    const digest = "c".repeat(64);
    const tempName = `${digest}.4321.00000000-0000-4000-8000-000000000004.tmp`;
    const tempPath = join(pendingDir, tempName);
    await writeFile(tempPath, "retry raw prompt", "utf8");
    const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(tempPath, expired, expired);

    await savePendingTurn({
      client: "codex", sourceSessionId: "temp-failure-trigger", prompt: "trigger", skip: false, submittedAt: new Date().toISOString()
    }, {
      runtimeDir,
      fs: {
        unlink: async (path) => {
          if (path === tempPath) throw new Error("injected temp unlink failure");
          return rm(path);
        }
      }
    });
    assert.equal(await readFile(tempPath, "utf8"), "retry raw prompt");
    assert.equal((await readdir(pendingDir)).includes(`${digest}.json`), false);

    await savePendingTurn({
      client: "codex", sourceSessionId: "temp-retry-trigger", prompt: "trigger", skip: false, submittedAt: new Date().toISOString()
    }, { runtimeDir });
    await assert.rejects(() => access(tempPath));
  });
});

test("enqueueCapture persists one JSON object per line without unrelated secrets", async () => {
  await withRuntime(async (runtimeDir) => {
    const queued = await enqueueCapture({
      ...captureRecord("filtered user text"),
      apiKey: "must-not-be-written",
      callbackResult: { recalled: "must-not-be-written" }
    }, { runtimeDir });

    assert.equal(queued, true);
    const source = await readFile(join(runtimeDir, "capture-queue.jsonl"), "utf8");
    const lines = source.trimEnd().split("\n");
    assert.equal(lines.length, 1);
    const saved = JSON.parse(lines[0]);
    assert.equal(saved.memorySessionId, "codex-0123456789abcdef01234567");
    assert.deepEqual(saved.messages, captureRecord("filtered user text").messages);
    assert.equal(source.includes("must-not-be-written"), false);
  });
});

test("concurrent hook processes append without overwriting either record", async () => {
  await withRuntime(async (runtimeDir) => {
    const gate = join(runtimeDir, "start.gate");
    const childScript = `
      import { access } from "node:fs/promises";
      import { enqueueCapture } from ${JSON.stringify(stateStoreUrl)};
      while (true) { try { await access(process.env.TEST_GATE); break; } catch { await new Promise(r => setTimeout(r, 5)); } }
      await enqueueCapture({ memorySessionId: "codex-test", messages: [
        { role: "user", content: process.env.TEST_CONTENT, timestamp: "2026-08-08T00:00:00.000Z" },
        { role: "assistant", content: "reply", timestamp: "2026-08-08T00:00:01.000Z" }
      ] }, { runtimeDir: process.env.TEST_RUNTIME });
    `;
    const first = runChild(childScript, { TEST_RUNTIME: runtimeDir, TEST_GATE: gate, TEST_CONTENT: "first" });
    const second = runChild(childScript, { TEST_RUNTIME: runtimeDir, TEST_GATE: gate, TEST_CONTENT: "second" });
    await writeFile(gate, "go", "utf8");
    await Promise.all([first, second]);

    const lines = (await readFile(join(runtimeDir, "capture-queue.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => JSON.parse(line).messages[0].content).sort(), ["first", "second"]);
  });
});

test("a later enqueue recovers a complete ready rebuild retained after an atomic replace failure", async () => {
  await withRuntime(async (runtimeDir) => {
    const oldRecord = storedCaptureRecord("old");
    const retainedRecord = storedCaptureRecord("retained");
    await writeFile(join(runtimeDir, "capture-queue.jsonl"), `${JSON.stringify(oldRecord)}\n`, "utf8");
    await writeFile(
      join(runtimeDir, ".capture-queue-rebuild-crashed.ready"),
      `${JSON.stringify(oldRecord)}\n${JSON.stringify(retainedRecord)}\n`,
      "utf8"
    );

    assert.equal(await enqueueCapture(captureRecord("new"), { runtimeDir }), true);

    const lines = (await readFile(join(runtimeDir, "capture-queue.jsonl"), "utf8")).trim().split("\n");
    assert.deepEqual(lines.map((line) => JSON.parse(line).messages[0].content), ["old", "retained", "new"]);
    assert.equal((await readdir(runtimeDir)).some((name) => name.endsWith(".ready")), false);
  });
});

test("partial building and invalid ready artifacts never replace the canonical queue", async () => {
  await withRuntime(async (runtimeDir) => {
    const canonical = storedCaptureRecord("canonical");
    await writeFile(join(runtimeDir, "capture-queue.jsonl"), `${JSON.stringify(canonical)}\n`, "utf8");
    await writeFile(join(runtimeDir, ".capture-queue-rebuild-interrupted.building"), '{"partial":', "utf8");
    await writeFile(join(runtimeDir, ".capture-queue-rebuild-invalid.ready"), '{"invalid":true}\n', "utf8");

    assert.equal(await enqueueCapture(captureRecord("new"), { runtimeDir }), true);

    const queue = (await readFile(join(runtimeDir, "capture-queue.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(queue[0].messages[0].content, "canonical");
    assert.equal(queue.some((record) => record.messages?.[0]?.content === "new"), true);
    await assert.rejects(() => access(join(runtimeDir, ".capture-queue-rebuild-interrupted.building")));
    assert.equal((await readdir(runtimeDir)).some((name) => name.endsWith(".invalid")), true);
  });
});

test("a ready artifact is preserved when the real filesystem cannot replace the canonical path", async () => {
  await withRuntime(async (runtimeDir) => {
    await mkdir(join(runtimeDir, "capture-queue.jsonl"));
    const readyPath = join(runtimeDir, ".capture-queue-rebuild-blocked.ready");
    await writeFile(readyPath, `${JSON.stringify(storedCaptureRecord("ready"))}\n`, "utf8");

    assert.equal(await enqueueCapture(captureRecord("new"), { runtimeDir }), true);
    assert.equal((await stat(join(runtimeDir, "capture-queue.jsonl"))).isDirectory(), true);
    assert.equal((await stat(readyPath)).isFile(), true);
  });
});

test("caller-supplied equal digests cannot collapse distinct normalized captures", async () => {
  await withRuntime(async (runtimeDir) => {
    const forged = "a".repeat(64);
    await enqueueCapture({ ...captureRecord("first"), digest: forged }, { runtimeDir });
    await enqueueCapture({ ...captureRecord("second"), digest: forged }, { runtimeDir });
    const records = [];
    await drainCaptureQueue(3, async (record) => { records.push(record); return true; }, { runtimeDir });

    assert.deepEqual(records.map((record) => record.messages[0].content), ["first", "second"]);
    assert.notEqual(records[0].digest, records[1].digest);
    assert.equal(records.some((record) => record.digest === forged), false);
  });
});

test("queue overflow preserves old data, rejects the new record, and logs no content", async () => {
  await withRuntime(async (runtimeDir) => {
    await mkdir(runtimeDir, { recursive: true });
    const queuePath = join(runtimeDir, "capture-queue.jsonl");
    const oldLine = `${JSON.stringify({ old: "x".repeat(20 * 1024 * 1024 - 20) })}\n`;
    await writeFile(queuePath, oldLine, "utf8");
    const oldSize = (await stat(queuePath)).size;

    assert.equal(await enqueueCapture(captureRecord("private overflow content"), { runtimeDir }), false);
    assert.equal((await stat(queuePath)).size, oldSize);
    assert.equal((await readFile(queuePath, "utf8")).includes("private overflow content"), false);
    const runtimeFiles = await readdir(runtimeDir);
    const warningName = runtimeFiles.find((name) => name.endsWith(".log"));
    assert.ok(warningName);
    assert.equal((await readFile(join(runtimeDir, warningName), "utf8")).includes("private overflow content"), false);
  });
});

test("enqueueCapture reports false when it cannot create a durable spool file", async () => {
  await withRuntime(async (runtimeDir) => {
    const blockedRuntime = join(runtimeDir, "not-a-directory");
    await writeFile(blockedRuntime, "occupied", "utf8");

    assert.equal(
      await enqueueCapture(captureRecord("cannot be persisted"), { runtimeDir: blockedRuntime }),
      false
    );
  });
});

test("drainCaptureQueue removes successful oldest records and retains a failed record", async () => {
  await withRuntime(async (runtimeDir) => {
    for (const content of ["one", "two", "three"]) await enqueueCapture(captureRecord(content), { runtimeDir });
    const handled = [];
    const firstDrain = await drainCaptureQueue(2, async (record) => {
      handled.push(record.messages[0].content);
      return record.messages[0].content !== "two";
    }, { runtimeDir });
    assert.deepEqual(handled, ["one", "two"]);
    assert.deepEqual(firstDrain, { processed: 2, removed: 1, remaining: 2, stopped: true });

    const remaining = [];
    await drainCaptureQueue(3, async (record) => { remaining.push(record.messages[0].content); return true; }, { runtimeDir });
    assert.deepEqual(remaining, ["two", "three"]);
  });
});
