import { mkdtemp, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
});
