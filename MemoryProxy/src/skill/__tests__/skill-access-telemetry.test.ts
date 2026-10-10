import { describe, expect, it, vi } from "vitest";
import { extractResolvedSkillAccess } from "../skill-access-telemetry.js";
import { emitBridgeToolCallTelemetry } from "../../memory/bridge-telemetry.js";
import { buildToolCallLogRow, migrateSchema, toolCallTableDdl } from "../../clickhouse.js";

const detail = { skill_id: "skl-resolved", version: 3, content: "# Skill" };
const response = (data: unknown = detail, code = 0) => JSON.stringify({ code, data });

describe("resolved Skill access", () => {
  it.each(["get", "get-by-name"])("extracts Core identity and version for %s", (endpoint) => {
    expect(extractResolvedSkillAccess(endpoint, 200, response())).toEqual({ skillId: "skl-resolved", skillVersion: 3 });
  });
  it.each([
    ["get", 404, response()],
    ["get", 200, response(detail, 40401)],
    ["get", 200, "not JSON"],
    ["get", 200, "null"],
    ["get", 200, response({ skill_id: "skl-a", content: "body" })],
    ["get", 200, response({ ...detail, version: "3" })],
    ["get", 200, response({ ...detail, version: 0 })],
    ["get", 200, response({ ...detail, version: -1 })],
    ["get", 200, response({ ...detail, version: 1.5 })],
    ["get", 200, response({ ...detail, version: Number.MAX_SAFE_INTEGER + 1 })],
    ["get", 200, response({ ...detail, skill_id: " " })],
    ["get", 200, response({ ...detail, content: undefined })],
    ["search", 200, response()],
    ["files/read", 200, response()],
    ["get", 0, response()],
  ])("does not infer loaded from insufficient evidence (%s, %s, %s)", (endpoint, status, text) => {
    expect(extractResolvedSkillAccess(endpoint, status, text)).toBeUndefined();
  });
});

const input = {
  sessionKey: "claude-code:session", agentSource: "claude-code",
  bridgeSource: "skill-bridge", executedEndpoint: "get",
  requestBody: "x".repeat(600), upstreamStatus: 200, elapsedMs: 17,
};

describe("telemetry compatibility", () => {
  it("preserves resolved fields independently of truncated request and default turn", () => {
    const sink = vi.fn();
    emitBridgeToolCallTelemetry({ ...input, ...extractResolvedSkillAccess("get", 200, response()) }, sink);
    const row = buildToolCallLogRow(sink.mock.calls[0][0]);
    expect(row).toMatchObject({ skill_id: "skl-resolved", skill_version: 3, turn_seq: 0, elapsed_ms: 17, upstream_status: 200 });
    expect(row.request_body).toHaveLength(512);
    expect(JSON.stringify(row)).not.toContain("# Skill");
  });
  it("leaves Memory Bridge and model intent rows compatible", () => {
    for (const kind of ["bridge_call", "model_intent"]) {
      expect(buildToolCallLogRow({ ...input, timestamp: new Date().toISOString(), kind, bridgeSource: "memory-bridge" }))
        .toMatchObject({ kind, bridge_source: "memory-bridge", skill_id: "", skill_version: null, upstream_status: 200 });
    }
  });
  it("swallows synchronous sink exceptions", () => {
    expect(() => emitBridgeToolCallTelemetry(input, () => { throw new Error("sink down"); })).not.toThrow();
  });
  it("adds defaulted columns idempotently to existing tables", async () => {
    const command = vi.fn().mockResolvedValue({});
    const client = { command } as unknown as Parameters<typeof migrateSchema>[0];
    const cfg = { table: "usage_logs" } as Parameters<typeof migrateSchema>[1];
    await migrateSchema(client, cfg);
    await migrateSchema(client, cfg);
    const queries = command.mock.calls.map(([arg]) => arg.query);
    for (const definition of ["skill_id String DEFAULT ''", "skill_version Nullable(UInt64) DEFAULT NULL"]) {
      expect(queries.filter(q => q === `ALTER TABLE tool_call_logs ADD COLUMN IF NOT EXISTS ${definition}`)).toHaveLength(2);
      expect(toolCallTableDdl()).toContain(definition);
    }
  });
});
