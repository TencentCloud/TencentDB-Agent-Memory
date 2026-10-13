import { expect, it } from "vitest";
import * as schemas from "../src/gateway/generated/schemas.js";
import { parseL1Response } from "../src/offload/local-llm/parsers/l1-parser.js";
import { parseL1Response as parseServerL1 } from "../src/offload_server/parsers/l1-parser.js";
import { SessionRegistry } from "../src/offload/session-registry.js";
import { OffloadStateManager } from "../src/offload/state-manager.js";
for (const [name, parse, body] of [
  ["wiki list", schemas.listWikiMutationRequestSchema, {}],
  ["wiki create", schemas.createWikiMutationRequestSchema, { name: "synthetic" }],
  ["code graph list", schemas.listCodeGraphMutationRequestSchema, {}],
  ["code graph create", schemas.createCodeGraphMutationRequestSchema, { repo_url: "https://example.com/repo" }],
] as const) {
  it(`${name} enforces the published required team identity`, () => {
    expect(parse.safeParse(body).success).toBe(false);
    expect(parse.safeParse({ ...body, team_id: "synthetic-team" }).success).toBe(true);
  });
}
it("retains unavailable legacy Wiki update exports with explicit validation failure", () => {
  for (const schema of [schemas.updateWiki200Schema, schemas.updateWikiMutationRequestSchema, schemas.updateWikiMutationResponseSchema]) {
    expect(schema.safeParse({ wiki_id: "synthetic" }).success).toBe(false);
  }
});
it("retains complete legacy response validators", () => {
  const envelope = { code: 0, message: "synthetic", request_id: "synthetic" };
  expect(schemas.updateWikiErrorSchema.safeParse(envelope).success).toBe(true);
  expect(schemas.syncCodeGraph200Schema.safeParse(envelope).success).toBe(true);
});
it("local and service L1 parsers expose their actual result-reference contracts", () => {
  const raw = JSON.stringify([{ tool_call_id: "synthetic", summary: "synthetic" }]);
  expect(parseL1Response(raw)[0]).toMatchObject({ tool_call_id: "synthetic", result_ref: "" });
  expect(parseServerL1(raw)[0]).not.toHaveProperty("seq");
});
it("registry and manager counters yield finite distinct identities", () => {
  const a = new SessionRegistry("/synthetic"), b = new SessionRegistry("/synthetic");
  const c = new OffloadStateManager(), d = new OffloadStateManager();
  expect(Number.isFinite(a._registryId)).toBe(true); expect(b._registryId).toBe(a._registryId + 1);
  expect(Number.isFinite(c._instanceId)).toBe(true); expect(d._instanceId).toBe(c._instanceId + 1);
});
