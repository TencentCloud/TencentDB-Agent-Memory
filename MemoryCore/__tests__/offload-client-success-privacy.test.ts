import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { BackendClient } from "../src/offload/backend-client.js";

const marker = "synthetic-private-stage-value\nforged-log-line";
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async server => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }));
});
async function fixture(response: object) {
  const logs: string[] = [];
  const requests: Array<{ headers: http.IncomingHttpHeaders; body: unknown }> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.end(JSON.stringify(response));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const log = (message: string) => { logs.push(message); };
  const client = new BackendClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    { info: log, debug: log, warn: log, error: log }, "synthetic-auth", undefined, undefined, () => "synthetic-user");
  return { client, logs, requests };
}
function verify(f: Awaited<ReturnType<typeof fixture>>, request: object) {
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].body).toEqual(request);
  expect(f.requests[0].headers.authorization).toBe("Bearer synthetic-auth");
  expect(f.requests[0].headers["x-user-id"]).toBe("synthetic-user");
  expect(f.logs.join("\n")).not.toContain("synthetic-private-stage-value");
  expect(f.logs.join("\n")).not.toContain("forged-log-line");
  expect(f.logs.join("\n")).not.toContain("synthetic-auth");
}
describe("offload stage success diagnostic privacy", () => {
  it("L1 keeps tool names/IDs in transport but omits them from logs", async () => {
    const response = { entries: [{ tool_call_id: marker, score: 1 }] };
    const f = await fixture(response);
    const request = { recentMessages: marker, toolPairs: [{ toolName: marker, toolCallId: marker, params: marker, result: marker, timestamp: marker }] };
    expect(await f.client.l1Summarize(request)).toEqual(response); verify(f, request);
  });
  it("L1.5 omits task labels and MMD filenames from logs", async () => {
    const response = { taskCompleted: false, isContinuation: true, continuationMmdFile: marker, newTaskLabel: marker, isLongTask: true };
    const f = await fixture(response);
    const request = { recentMessages: marker, currentMmd: { filename: marker, content: marker, path: marker }, availableMmdMetas: [] };
    expect(await f.client.l15Judge(request)).toEqual(response); verify(f, request);
  });
  it("L2 omits task labels, prefixes, IDs and node mappings from logs", async () => {
    const response = { fileAction: "write", mmdContent: marker, nodeMapping: { [marker]: marker } };
    const f = await fixture(response);
    const request = { existingMmd: marker, newEntries: [{ tool_call_id: marker, tool_call: marker, summary: marker, timestamp: marker }], recentHistory: marker, currentTurn: marker, taskLabel: marker, mmdPrefix: marker, mmdCharCount: marker.length };
    expect(await f.client.l2Generate(request)).toEqual(response); verify(f, request);
  });
  it("L4 omits filenames, skill focus and generated names from logs", async () => {
    const response = { skillName: marker, skillDescription: marker, skillContent: marker };
    const f = await fixture(response);
    const request = { mmdFilename: marker, mmdContent: marker, offloadEntries: [], skillFocus: marker };
    expect(await f.client.l4Generate(request)).toEqual(response); verify(f, request);
  });
});
