import { expect, it, vi } from "vitest";
import { makeKnowledgeRouteTable } from "../src/gateway/knowledge-handlers.js";
import { MongoMemoryStore } from "../src/core/store/mongodb/memory-store.js";

const input = { knowledge_id: "synthetic-id", team_id: "synthetic-team", type: "wiki", service_url: "https://synthetic.invalid", name: "Synthetic Knowledge" };

it.each([
  { optional: {}, user: null, summary: null },
  { optional: { summary: null }, user: null, summary: null },
  { optional: { user_id: "synthetic-user", summary: "Synthetic summary" }, user: "synthetic-user", summary: "Synthetic summary" },
])("normalizes optional Knowledge fields through the actual Mongo create method: $optional", async ({ optional, user, summary }) => {
  const replaceOne = vi.fn(async (_filter: unknown, _document: unknown, _options: unknown) => ({}));
  // Only the database transport is mocked. The actual backend constructs both
  // the persisted document and returned entity; no Mongo server is required.
  const backend = Object.create(MongoMemoryStore.prototype);
  backend.coll = async () => ({ replaceOne });
  const result = await makeKnowledgeRouteTable()["/v3/knowledge/create"](
    { ...input, ...optional }, { service_id: "synthetic-service" } as never,
    "synthetic-request", { getStore: () => backend },
  );
  expect(result.code).toBe(0);
  expect(result.data).toMatchObject({ ...input, user_id: user, summary });
  expect(replaceOne).toHaveBeenCalledOnce();
  expect(replaceOne.mock.calls[0][0]).toEqual({ _id: input.knowledge_id, team_id: input.team_id });
  expect(replaceOne.mock.calls[0][1]).toMatchObject({ ...input, user_id: user, summary });
});

it("continues rejecting an explicit empty user identifier without writing", async () => {
  const createKnowledge = vi.fn();
  const result = await makeKnowledgeRouteTable()["/v3/knowledge/create"](
    { ...input, user_id: "" }, { service_id: "synthetic-service" } as never,
    "synthetic-request", { getStore: () => ({ createKnowledge }) },
  );
  expect(result.code).toBe(400);
  expect(createKnowledge).not.toHaveBeenCalled();
});
