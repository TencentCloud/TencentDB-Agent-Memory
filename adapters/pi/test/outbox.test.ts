import { mkdtemp, readdir, readFile, rename, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConversationMessages } from "../src/capture.js";
import { MAX_DELIVERY_ATTEMPTS, enqueueCapture, flushOutbox, outboxCount } from "../src/outbox.js";
import type { LoadedConfig } from "../src/types.js";

const directories: string[] = [];
const config: LoadedConfig = {
  enabled: true,
  endpoint: "http://127.0.0.1:8420",
  serviceId: "default",
  teamId: "team-test",
  agentId: "agent-test",
  userId: "user-test",
  userKey: "sk-mem-test",
  gatewayApiKey: "gateway-test",
  timeoutMs: 1000,
  rejectUnauthorized: true,
  captureTools: false,
  recall: { enabled: true, deadlineMs: 3_000, l0Limit: 4, l1Limit: 6, l2Limit: 2, maxChars: 12000 },
  skills: { enabled: false, capture: true, runtimeTools: true, routingMode: "bm25", allowTeamSearch: false, includeFailedTools: false, maxMessageBytes: 32768, maxToolItems: 16, flushTimeoutMs: 1500 },
  sources: [],
  userKeySource: "test",
  gatewayApiKeySource: "test",
};

async function outbox(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tdai-outbox-test-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => {
    const files = await readdir(directory);
    await Promise.all(files.map(async (file) => (await import("node:fs/promises")).rm(join(directory, file), { force: true })));
    await (await import("node:fs/promises")).rm(directory, { recursive: true, force: true });
  }));
});

describe("persistent capture outbox", () => {
  it("keeps a failed delivery and retries it in FIFO order", async () => {
    const directory = await outbox();
    let now = new Date("2026-08-14T00:00:00.000Z");
    const options = { directory, now: () => now, retryDelayMs: () => 1_000 };
    const first = await enqueueCapture(config, "pi-one", [{ role: "user", content: "first" }], options);
    const second = await enqueueCapture(config, "pi-two", [{ role: "user", content: "second" }], options);
    const attempted: string[] = [];

    const failed = await flushOutbox(config, async (record) => {
      attempted.push(record.id);
      throw new Error("offline");
    }, options);
    expect(attempted).toEqual([first.id]);
    expect(failed).toEqual({ delivered: 0, pending: 1, invalid: 0, dead: 0 });
    expect(await outboxCount(config, options)).toBe(2);

    const tooSoon = await flushOutbox(config, async (record) => {
      attempted.push(record.id);
    }, options);
    expect(tooSoon).toEqual({ delivered: 0, pending: 1, invalid: 0, dead: 0 });
    expect(attempted).toEqual([first.id]);

    now = new Date(now.getTime() + 1_000);
    const recovered = await flushOutbox(config, async (record) => {
      attempted.push(record.id);
    }, options);
    expect(attempted.slice(1)).toEqual([first.id, second.id]);
    expect(recovered).toEqual({ delivered: 2, pending: 0, invalid: 0, dead: 0 });
    expect(await outboxCount(config, options)).toBe(0);
  });

  it("does not send another agent's queued conversation", async () => {
    const directory = await outbox();
    await enqueueCapture({ ...config, agentId: "other-agent" }, "pi-other", [{ role: "user", content: "private" }], { directory });
    const delivered: string[] = [];
    const result = await flushOutbox(config, async (record) => {
      delivered.push(record.id);
    }, { directory });
    expect(delivered).toEqual([]);
    expect(result).toEqual({ delivered: 0, pending: 1, invalid: 0, dead: 0 });
  });

  it("does not execute or delete malformed files", async () => {
    const directory = await outbox();
    await writeFile(join(directory, "bad.json"), "not json");
    const result = await flushOutbox(config, async () => undefined, { directory });
    expect(result).toEqual({ delivered: 0, pending: 0, invalid: 1, dead: 0 });
    expect(await readdir(directory)).toContain("bad.json");
  });

  it("serializes concurrent flushes so a record is delivered at most once per process", async () => {
    const directory = await outbox();
    await enqueueCapture(config, "pi-one", [{ role: "user", content: "only once" }], { directory });
    let release: (() => void) | undefined;
    let deliveries = 0;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deliver = async () => {
      deliveries += 1;
      await started;
    };

    const first = flushOutbox(config, deliver, { directory });
    const second = flushOutbox(config, deliver, { directory });
    release?.();
    await Promise.all([first, second]);
    expect(deliveries).toBe(1);
    expect(await outboxCount(config, { directory })).toBe(0);
  });

  it("moves a permanently failing record to .dead and continues with later records", async () => {
    const directory = await outbox();
    let now = new Date("2026-08-14T00:00:00.000Z");
    const options = { directory, now: () => now, retryDelayMs: () => 1_000 };
    const first = await enqueueCapture(config, "pi-one", [{ role: "user", content: "broken" }], options);
    const second = await enqueueCapture(config, "pi-two", [{ role: "user", content: "later" }], options);
    const attempted: string[] = [];

    for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS - 1; attempt += 1) {
      await flushOutbox(config, async (record) => {
        attempted.push(record.id);
        throw new Error("permanent failure");
      }, options);
      now = new Date(now.getTime() + 1_000);
    }
    const final = await flushOutbox(config, async (record) => {
      attempted.push(record.id);
      if (record.id === first.id) throw new Error("permanent failure");
    }, options);

    expect(attempted).toEqual([first.id, first.id, first.id, second.id]);
    expect(final).toEqual({ delivered: 1, pending: 0, invalid: 0, dead: 1 });
    expect(await readdir(directory)).toEqual(expect.arrayContaining([expect.stringMatching(/\.json\.dead$/)]));
    expect(await outboxCount(config, options)).toBe(0);
  });

  it("does not steal an active lease but recovers a crashed worker's stale lease", async () => {
    const directory = await outbox();
    const options = { directory };
    await enqueueCapture(config, "pi-one", [{ role: "user", content: "recover me" }], options);
    const file = (await readdir(directory)).find((entry) => entry.endsWith(".json"));
    expect(file).toBeDefined();
    const recordPath = join(directory, file as string);
    await rename(recordPath, `${recordPath}.lease-crashed-worker`);

    let delivered = 0;
    const active = await flushOutbox(config, async () => {
      delivered += 1;
    }, { ...options, leaseTimeoutMs: 60_000 });
    expect(active).toEqual({ delivered: 0, pending: 0, invalid: 0, dead: 0 });
    expect(delivered).toBe(0);
    expect(await outboxCount(config, options)).toBe(1);

    const recovered = await flushOutbox(config, async () => {
      delivered += 1;
    }, {
      ...options,
      now: () => new Date(Date.now() + 60_001),
      leaseTimeoutMs: 60_000,
    });
    expect(recovered).toEqual({ delivered: 1, pending: 0, invalid: 0, dead: 0 });
    expect(delivered).toBe(1);
    expect(await outboxCount(config, options)).toBe(0);
  });

  it("keeps a lease alive while its claim stamp is fresh, then reclaims once both signals age", async () => {
    // The claim stamp is embedded in the filename atomically at claim time, so
    // a claim stays live by its stamp even when the file mtime is ancient
    // (rename() preserves the record's original mtime). Only when BOTH the
    // stamp and the mtime have aged past the timeout is the lease reclaimed.
    const directory = await outbox();
    const options = { directory };
    await enqueueCapture(config, "pi-one", [{ role: "user", content: "stamped claim" }], options);
    const file = (await readdir(directory)).find((entry) => entry.endsWith(".json"));
    expect(file).toBeDefined();
    const recordPath = join(directory, file as string);
    const leasePath = `${recordPath}.lease-9999-${Date.now()}-00000000-0000-4000-8000-000000000000`;
    await rename(recordPath, leasePath);
    const ancient = new Date(Date.now() - 120_000);
    await utimes(leasePath, ancient, ancient);

    let delivered = 0;
    const live = await flushOutbox(config, async () => { delivered += 1; }, options);
    expect(live).toEqual({ delivered: 0, pending: 0, invalid: 0, dead: 0 });
    expect(delivered).toBe(0);
    expect(await outboxCount(config, options)).toBe(1);

    const recovered = await flushOutbox(config, async () => { delivered += 1; }, {
      ...options,
      now: () => new Date(Date.now() + 60_001),
      leaseTimeoutMs: 60_000,
    });
    expect(recovered).toEqual({ delivered: 1, pending: 0, invalid: 0, dead: 0 });
    expect(delivered).toBe(1);
    expect(await outboxCount(config, options)).toBe(0);
  });

  it("renews a lease while a delivery outlives the lease timeout", async () => {
    // A slow network delivery can exceed the lease timeout. The heartbeat
    // refreshes the lease's mtime every third of the timeout, so a concurrent
    // flusher's reclaim pass must still see the lease as live.
    const directory = await outbox();
    const options = { directory, leaseTimeoutMs: 300 };
    await enqueueCapture(config, "pi-one", [{ role: "user", content: "slow delivery" }], options);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const flushing = flushOutbox(config, async () => { await gate; }, options);

    const deadline = Date.now() + 5_000;
    let leaseName: string | undefined;
    while (Date.now() < deadline) {
      leaseName = (await readdir(directory)).find((name) => name.includes(".json.lease-"));
      if (leaseName) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(leaseName).toBeDefined();
    const leasePath = join(directory, leaseName as string);

    // Wait past the 300ms lease timeout. The heartbeat (every 100ms) must have
    // kept refreshing the mtime; an aged mtime here would mean a concurrent
    // reclaim would steal the lease mid-delivery.
    await new Promise((resolve) => setTimeout(resolve, 450));
    const metadata = await stat(leasePath);
    expect(Date.now() - metadata.mtimeMs).toBeLessThan(300);

    release?.();
    await flushing;
    expect(await outboxCount(config, options)).toBe(0);
  });
});

describe("outbox persistence hygiene", () => {
  it("persists nothing secret to disk: the queued JSON is redacted before it is written", async () => {
    const directory = await outbox();
    // The redaction happens in createConversationMessages (before enqueue); this
    // test proves the bytes that actually land in the outbox file are already
    // scrubbed, not merely that redactText() returns a clean string in memory.
    const messages = createConversationMessages(
      "roll out with Authorization: Bearer secret-123",
      "set API_KEY=sk-example-secret and rerun the deploy",
      [
        {
          toolName: "bash",
          isError: false,
          content: [
            { type: "text", text: "export API_KEY=sk-example-secret\ncurl -H 'Authorization: Bearer secret-123'" },
          ],
        },
      ],
    );
    await enqueueCapture(config, "pi-redact", messages, { directory });

    const files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(1);
    const raw = await readFile(join(directory, files[0] as string), "utf8");
    expect(raw).not.toContain("secret-123");
    expect(raw).not.toContain("sk-example-secret");
    expect(raw).toContain("[REDACTED]");
  });
});
