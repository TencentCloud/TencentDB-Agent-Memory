import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// Isolate metadata registration; routing, capture, TdaiClient and outbox remain real.
vi.mock("../../pipeline/stages/session-init-orchestrate.js", () => ({
  stageSessionInitOrchestrate: async (input: { sessionKey: string; userId: string }) => ({
    proceed: true, wentThroughStateMachine: false, initResult: {
      intercepted: false, bypassed: false,
      sessionInfo: { team_id: "t", agent_id: "a", user_id: input.userId, session_id: input.sessionKey, task_id: "task" },
    },
  }),
}));
vi.mock("../../instance-upstream-cache.js", async original => ({
  ...await original<object>(), getInstanceUpstreamConfigs: async () => [],
}));
import { DEFAULT_CONFIG } from "../../config.js";
import { createApp } from "../../server.js";
import { PiOutboxStore } from "../pi-outbox-store.js";

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(stream = false) {
  const directory = await mkdtemp(join(tmpdir(), "pi-pipeline-test-")); directories.push(directory);
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstream.url = "http://upstream.test/v1/chat/completions";
  config.sessionInit.enabled = true;
  config.extraction = { enabled: true, extractors: ["tdai-memory"] };
  config.tdai = { ...config.tdai, enabled: true, endpoint: "http://memory.test", apiKey: "fixture-key",
    memory: { ...config.tdai.memory, enabled: true, writeL0: true },
    piOutbox: { enabled: true, directory, idempotencyContract: "1142" } };
  const gateway: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).includes("/v3/conversation/add")) {
      gateway.push(String(init!.body));
      return Response.json({ code: 0, data: { accepted_ids: ["1", "2"], total_count: 2 } });
    }
    if (!String(url).includes("upstream.test")) return Response.json({ code: 0, data: {} });
    return stream ? new Response('data: {"choices":[{"delta":{"content":"reply"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } }) : Response.json({ choices: [
        { message: { role: "assistant", content: "reply" }, finish_reason: "stop" },
      ] });
  });
  const request = (agent = "pi", conversation = "pi-session") => createApp(config).request(
    `http://localhost/${agent}/tenant/v1/chat/completions`, { method: "POST", headers: {
      "content-type": "application/json", "x-conversation-id": conversation, "x-user-id": "u",
    }, body: JSON.stringify({ model: "test-model", stream, messages: [{ role: "user", content: "question" }] }) });
  return { config, request, gateway, store: new PiOutboxStore(directory) };
}

it.each([false, true])("automatically captures a real Pi pipeline response without a direct gateway write (stream: %s)", async stream => {
  const { request, gateway, store } = await fixture(stream);
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("reply");
  const records = (await store.recover()).records;
  expect(records).toHaveLength(1);
  expect(records[0].scope).toMatchObject({ serviceId: "tenant", teamId: "t", agentId: "a", userId: "u" });
  expect(JSON.parse(records[0].body)).toMatchObject({ task_id: "task", messages: [
    { role: "user", content: "question" }, { role: "assistant", content: "reply" },
  ] });
  expect(gateway).toHaveLength(0);
  await (await request()).text();
  const keys = (await store.recover()).records.map(record => JSON.parse(record.body).idempotency_key);
  expect(new Set(keys).size).toBe(2);
});

it("preserves the direct path for other clients and for Pi when disabled", async () => {
  const { config, request, gateway, store } = await fixture();
  expect((await request("codebuddy", "cb-session")).status).toBe(200);
  config.tdai.piOutbox!.enabled = false;
  expect((await request()).status).toBe(200);
  expect(gateway).toHaveLength(2);
  expect((await store.recover()).records).toHaveLength(0);
});

it.each(["extraction", "writeL0", "identity"])("does not bypass the existing %s gate", async gate => {
  const { config, request, store, gateway } = await fixture();
  if (gate === "extraction") config.extraction.enabled = false;
  if (gate === "writeL0") config.tdai.memory.writeL0 = false;
  await (await request("pi", gate === "identity" ? "" : "pi-session")).text();
  expect((await store.recover()).records).toHaveLength(0);
  expect(gateway).toHaveLength(0);
});

it.each([false, true])("surfaces disk failure without falling back to direct delivery (stream: %s)", async stream => {
  const { request, gateway } = await fixture(stream);
  vi.spyOn(PiOutboxStore.prototype, "enqueue").mockRejectedValue(new Error("fixture disk full"));
  const response = await request();
  if (stream) await expect(response.text()).rejects.toThrow("fixture disk full");
  else expect(response.status).toBe(500);
  expect(gateway).toHaveLength(0);
});
