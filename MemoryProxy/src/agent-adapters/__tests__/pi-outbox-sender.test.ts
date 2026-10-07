import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createPiOutboxSender } from "../pi-outbox-sender.js";
import type { PiOutboxRecord } from "../pi-outbox-store.js";

const servers: Server[] = [];
const record: PiOutboxRecord = { version: 1, id: "test", scope: {
  serviceId: "s", teamId: "t", agentId: "a", userId: "u", sessionId: "session",
}, body: JSON.stringify({ session_id: "session", idempotency_key: "turn-1", messages: [{ role: "user", content: "hello" }] }) };
async function serve(status: number, body: unknown, observe?: (body: string, headers: Record<string, unknown>) => void) {
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    observe?.(text, req.headers);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  return createPiOutboxSender({ endpoint: `http://127.0.0.1:${address.port}`, idempotencyContract: "1142", resolveApiKey: () => "test-key" });
}
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
  server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
}))); });

describe("Strict outbox gateway sender (#1391 / #1142)", () => {
  it("sends exact bytes, the fixed key and all scope headers, accepting a verified 202 receipt", async () => {
    const send = await serve(202, { code: 0, data: { accepted_ids: ["msg-1"], total_count: 1 } }, (body, headers) => {
      expect(body).toBe(record.body);
      expect(headers).toMatchObject({ authorization: "Bearer test-key", "x-tdai-service-id": "s",
        "x-tdai-team-id": "t", "x-tdai-agent-id": "a", "x-tdai-user-id": "u", "x-tdai-session-id": "session" });
    });
    expect(await send(record, new AbortController().signal)).toEqual({ ok: true });
  });

  it.each([
    [409, false, "conflict"], [401, false, "auth"], [403, false, "auth"],
    [400, false, "rejected"], [408, true, "rejected"], [429, true, "rejected"], [503, true, "server"],
  ])("classifies HTTP %i without returning the response text", async (code, retryable, reason) => {
    const send = await serve(code as number, { message: "secret data" });
    expect(await send(record, new AbortController().signal)).toEqual({ ok: false, retryable, reason });
  });

  it("recognizes a conflict inside a 200 response envelope", async () => {
    const send = await serve(200, { code: 409, message: "secret data" });
    expect(await send(record, new AbortController().signal)).toEqual({ ok: false, retryable: false, reason: "conflict" });
  });

  it.each([{}, null, { code: 0 }, { code: 0, data: { accepted_ids: [], total_count: 0 } }])(
    "never acknowledges an incomplete success response %j", async body => {
      const send = await serve(200, body);
      expect(await send(record, new AbortController().signal)).toEqual({ ok: false, retryable: true, reason: "malformed" });
    },
  );
});
