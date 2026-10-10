import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../config.js";
import { buildPiTdaiClient } from "../pi.js";
import { createPiConversationWrite, startPiOutbox } from "../pi-outbox-runtime.js";
import { PiOutboxStore } from "../pi-outbox-store.js";
import { createPiDurableStreamTap } from "../pi-outbox-stream.js";

const paths: string[] = [];
const identity = { teamId: "t", agentId: "a", userId: "u", sessionId: "s", taskId: "task", userKey: "never-store" };
const messages = [{ role: "user" as const, content: "same question" }, { role: "assistant" as const, content: "answer" }];
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "pi-runtime-test-")); paths.push(directory);
  const config = structuredClone(DEFAULT_CONFIG);
  config.tdai = { ...config.tdai, enabled: true, endpoint: "http://gateway.test", apiKey: "secret",
    memory: { ...config.tdai.memory, enabled: true, writeL0: true },
    piOutbox: { enabled: true, directory, idempotencyContract: "1142" } };
  return { config, store: new PiOutboxStore(directory) };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("Pi server-side capture", () => {
  it("snapshots one operation across concurrent local retries, preserves tenant/task, and gives a new request a new key", async () => {
    const { config, store } = await setup();
    const fetch = vi.spyOn(globalThis, "fetch");
    const client = buildPiTdaiClient(config, "tenant", "pi.request-1")!;
    await Promise.all([client.addConversation(identity, messages), client.addConversation(identity, messages)]);
    let records = (await store.recover()).records;
    expect(records).toHaveLength(1);
    expect(records[0].scope.serviceId).toBe("tenant");
    expect(JSON.parse(records[0].body)).toMatchObject({ idempotency_key: "pi.request-1", task_id: "task", messages });
    expect(JSON.stringify(records)).not.toMatch(/secret|never-store/);
    await buildPiTdaiClient(config, "tenant", "pi.request-2")!.addConversation(identity, messages);
    records = (await store.recover()).records;
    expect(records).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.addConversation(identity, [{ role: "user", content: "changed" }])).rejects.toThrow("changed");
  });

  it("splits long Unicode messages without data loss and retains one stable key per gateway batch", async () => {
    const { config, store } = await setup();
    const content = "😀".repeat(4097 * 101);
    await buildPiTdaiClient(config, "tenant", "pi.long")!.addConversation(identity, [{ role: "assistant", content }]);
    const bodies = (await store.recover()).records.map(record => JSON.parse(record.body))
      .sort((a, b) => a.idempotency_key.localeCompare(b.idempotency_key));
    expect(bodies).toHaveLength(2);
    expect(bodies.map(body => body.idempotency_key)).toEqual(["pi.long.0", "pi.long.1"]);
    const chunks = bodies.flatMap(body => body.messages.map((message: { content: string }) => message.content));
    expect(chunks.every(text => text.length <= 8192 && !/[\uD800-\uDBFF]$/.test(text))).toBe(true);
    expect(chunks.join("")).toBe(content);
  });

  it("retries a partially published operation without enqueueing its successful batch again", async () => {
    const { config, store } = await setup();
    const original = store.enqueue.bind(store);
    const enqueue = vi.spyOn(store, "enqueue").mockImplementationOnce(original).mockRejectedValueOnce(new Error("disk unavailable"));
    enqueue.mockImplementation(original);
    const write = createPiConversationWrite(config.tdai, "tenant", "pi.partial", store);
    await expect(write(identity, [messages, messages])).rejects.toThrow("disk unavailable");
    await write(identity, [messages, messages]);
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect((await store.recover()).records).toHaveLength(2);
  });

  it("keeps the write switch effective and rejects an unverified contract", async () => {
    const { config, store } = await setup();
    config.tdai.memory.writeL0 = false;
    await buildPiTdaiClient(config, "tenant", "pi.disabled")!.addConversation(identity, messages);
    expect((await store.recover()).records).toHaveLength(0);
    config.tdai.piOutbox!.idempotencyContract = "";
    await expect(startPiOutbox(config.tdai)).rejects.toThrow("1142");
  });

  it("automatically delivers existing and new records and preserves pending work on stop", async () => {
    const { config, store } = await setup();
    await buildPiTdaiClient(config, "tenant", "pi.before-start")!.addConversation(identity, messages);
    let available = true;
    const sent: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (!available) return new Response("", { status: 503 });
      sent.push(String(init!.body));
      return Response.json({ code: 0, data: { accepted_ids: ["user", "assistant"], total_count: 2 } });
    });
    const runtime = await startPiOutbox(config.tdai);
    try {
      await vi.waitFor(async () => expect((await store.inspect()).entries).toHaveLength(0));
      await buildPiTdaiClient(config, "tenant", "pi.after-start")!.addConversation(identity, messages);
      await vi.waitFor(() => expect(sent).toHaveLength(2), { timeout: 4000 });
      available = false;
      await buildPiTdaiClient(config, "tenant", "pi.pending")!.addConversation(identity, messages);
      await vi.waitFor(async () => expect((await store.inspect()).entries[0]?.attempts).toBe(1), { timeout: 4000 });
    } finally { await runtime.stop(); }
    expect((await store.inspect()).entries).toHaveLength(1);
    available = true;
    const restarted = await startPiOutbox(config.tdai);
    try { await vi.waitFor(async () => expect((await store.inspect()).entries).toHaveLength(0), { timeout: 4000 }); }
    finally { await restarted.stop(); }
    expect(sent.map(body => JSON.parse(body).idempotency_key)).toEqual(["pi.before-start", "pi.after-start", "pi.pending"]);
  });
});

describe("Pi stream durability boundary", () => {
  it("passes UTF-8 content while withholding DONE until commit, even with split CRLF frames", async () => {
    const text = 'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: [DONE]\r\n\r\n';
    const bytes = new TextEncoder().encode(text);
    let release!: () => void;
    const committed = new Promise<void>(resolve => { release = resolve; });
    const commit = vi.fn(() => committed);
    const source = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
    const reader = source.pipeThrough(createPiDurableStreamTap(() => {}, commit)).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("你好");
    let finished = false;
    const terminal = reader.read().then(result => { finished = true; return result; });
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    release();
    expect(new TextDecoder().decode((await terminal).value)).toContain("[DONE]");
    expect((await reader.read()).done).toBe(true);
  });

  it.each([false, true])("rejects completion when stream or local commit fails (commit failure: %s)", async (failCommit) => {
    const commit = vi.fn(async () => { throw new Error("disk full"); });
    const input = new Response('data: {"choices":[]}\n\n' + (failCommit ? 'data: [DONE]\n\n' : "")).body!;
    await expect(new Response(input.pipeThrough(createPiDurableStreamTap(() => {}, commit))).text())
      .rejects.toThrow(failCommit ? "disk full" : "terminal event");
    expect(commit).toHaveBeenCalledTimes(failCommit ? 1 : 0);
  });
});
