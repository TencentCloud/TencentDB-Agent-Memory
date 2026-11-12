import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SkillClient } from "../src/v3/skill-client.js";
import { ParamError } from "../src/errors.js";
import type { SkillRestructureOperation, SkillRestructureRequest } from "../src/v3/skill-types.js";

const operation: SkillRestructureOperation = { operation_id: `sro-${"a".repeat(32)}`, status: "queued", source_skill_id: "skl-source", source_version: 2,
  attempts: 0, outputs: [], created_at_ms: 1, updated_at_ms: 1 };
const ids = { user_id: "user", team_id: "team", agent_id: "agent", task_id: "task" };

describe("SkillClient restructuring wire contract (local HTTP server, no model)", () => {
  let server: Server;
  let client: SkillClient;
  let seen: Array<{ path: string; method: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> }>;
  let response: { status: number; envelope: Record<string, unknown> };
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      seen.push({ path: req.url!, method: req.method!, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(response.status, { "content-type": "application/json", "x-qcloud-transaction-id": "server-trace" });
      res.end(JSON.stringify(response.envelope));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    client = new SkillClient({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "test-key", serviceId: "instance-a",
      userId: ids.user_id, teamId: ids.team_id, agentId: ids.agent_id, taskId: ids.task_id });
  });
  beforeEach(() => { seen = []; response = { status: 200, envelope: { code: 0, message: "ok", request_id: "trace", data: operation } }; });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

  it("posts existing-package requests with stable caller intent and default identities", async () => {
    const input: SkillRestructureRequest = { request_id: "caller-stable", skill_id: "skl-source", expected_version: 2, reason: "refactor package" };
    expect(await client.restructure(input)).toEqual(operation);
    expect(await client.restructure(input)).toEqual(operation);
    expect(seen.map(item => item.path)).toEqual(["/v3/skill/restructure", "/v3/skill/restructure"]);
    expect(seen[0].body).toEqual({ ...ids, ...input });
    expect(seen[1].body.request_id).toBe("caller-stable");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers["x-tdai-service-id"]).toBe("instance-a");
  });

  it("passes complete candidate/source payloads without converting them to CRUD", async () => {
    const input: SkillRestructureRequest = { request_id: "candidate-stable", candidate: { name: "guide", content: "large candidate",
      resources: [SkillClient.encodeBase64("run", Buffer.from([0, 255]), { mime_type: "application/x-test", is_executable: true })], metadata: { keep: true } },
      source: { skill_id: "skl-source", expected_version: 2 }, team_id: "override-team", agent_id: "override-agent" };
    await client.restructure(input);
    expect(seen[0].path).toBe("/v3/skill/restructure");
    expect(seen[0].body).toEqual({ ...ids, ...input });
    expect(seen[0].body).not.toHaveProperty("force");
    expect(seen[0].body).not.toHaveProperty("skill_id");
  });

  it("posts operation queries with identity overrides and returns typed asynchronous outputs", async () => {
    const finished: SkillRestructureOperation = { ...operation, status: "succeeded", outputs: [{ key: "root", skill_id: "skl-source", version: 3, name: "guide", role: "root", reused: false }], rationale: "Split responsibilities" };
    response.envelope.data = finished;
    expect(await client.restructureGet({ operation_id: operation.operation_id, user_id: "other-user" })).toEqual(finished);
    expect(seen[0].path).toBe("/v3/skill/restructure/get");
    expect(seen[0].body).toEqual({ ...ids, user_id: "other-user", operation_id: operation.operation_id });
    expect(seen[0].method).toBe("POST");
  });

  it("rejects a missing stable request or operation id locally without inventing one", () => {
    expect(() => client.restructure({ request_id: " ", skill_id: "s", expected_version: 1 })).toThrow(ParamError);
    expect(() => client.restructureGet({ operation_id: "" })).toThrow(ParamError);
    expect(seen).toEqual([]);
  });

  it("preserves standard business errors and committed-publication details", async () => {
    response = { status: 503, envelope: { code: 50301, message: "ASSET_REGISTRATION_PENDING", request_id: "trace",
      data: { publication_committed: true, error_code: "ASSET_REGISTRATION_PENDING" } } };
    await expect(client.restructure({ request_id: "stable", skill_id: "skl-source", expected_version: 2 })).rejects.toMatchObject({
      name: "TDAMError", code: 50301, requestId: "server-trace", details: { publication_committed: true },
    });
    response = { status: 200, envelope: { code: 40401, message: "Operation not found", request_id: "trace" } };
    await expect(client.restructureGet({ operation_id: operation.operation_id })).rejects.toMatchObject({ name: "TDAMError", code: 40401 });
  });
});
