import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { enqueueCapture, flushOutbox, outboxCount } from "../src/outbox.js";
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
  recall: { enabled: true, l0Limit: 4, l1Limit: 6, l2Limit: 2, maxChars: 12000 },
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
    const options = { directory };
    const first = await enqueueCapture(config, "pi-one", [{ role: "user", content: "first" }], options);
    const second = await enqueueCapture(config, "pi-two", [{ role: "user", content: "second" }], options);
    const attempted: string[] = [];

    const failed = await flushOutbox(config, async (record) => {
      attempted.push(record.id);
      throw new Error("offline");
    }, options);
    expect(attempted).toEqual([first.id]);
    expect(failed).toEqual({ delivered: 0, pending: 1, invalid: 0 });
    expect(await outboxCount(config, options)).toBe(2);

    const recovered = await flushOutbox(config, async (record) => {
      attempted.push(record.id);
    }, options);
    expect(attempted.slice(1)).toEqual([first.id, second.id]);
    expect(recovered).toEqual({ delivered: 2, pending: 0, invalid: 0 });
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
    expect(result).toEqual({ delivered: 0, pending: 1, invalid: 0 });
  });

  it("does not execute or delete malformed files", async () => {
    const directory = await outbox();
    await writeFile(join(directory, "bad.json"), "not json");
    const result = await flushOutbox(config, async () => undefined, { directory });
    expect(result).toEqual({ delivered: 0, pending: 0, invalid: 1 });
    expect(await readdir(directory)).toContain("bad.json");
  });
});
