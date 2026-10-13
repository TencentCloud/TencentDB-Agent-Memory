import { expect, it, vi } from "vitest";
import { TdaiGateway } from "../src/gateway/server.js";

it.each([true, false, undefined])("reports FTS5 capability in health: %s", fts => {
  const vector = fts === undefined ? undefined : { isFtsAvailable: () => fts };
  const receiver = { core: { getVectorStore: () => vector, getEmbeddingService: () => undefined }, startTime: Date.now() };
  const res = { writeHead: vi.fn(), end: vi.fn() };
  const handler: unknown = Object.getOwnPropertyDescriptor(TdaiGateway.prototype, "handleHealth")?.value;
  if (typeof handler !== "function") throw new Error("Missing health handler");
  handler.call(receiver, res);
  expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
  const body = JSON.parse(res.end.mock.calls[0][0]);
  expect(body.status).toBe(vector ? "ok" : "degraded");
  expect(body.stores).toEqual({ vectorStore: !!vector, embeddingService: false, ftsAvailable: fts ?? false });
});
