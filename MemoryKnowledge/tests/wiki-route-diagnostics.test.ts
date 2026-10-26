import { afterEach, describe, expect, it, vi } from "vitest";
import { createWikiRoutes, type WikiRouteDeps } from "../src/routes/wiki.js";

const wiki = "synthetic-private-wiki";
const detail = "synthetic-private-error-detail";
const removed = { removed: ["synthetic-ref"], failed: [] };
const written = [{ ref: "synthetic-ref", written: true }];
const cases = [
  { route: "delete", body: { wiki_ids: [wiki] }, operation: "delete", manager: "remove", data: { deleted_ids: [wiki], failed: [] } },
  { route: "raw/rm", body: { wiki_id: wiki, team_id: "synthetic-team", filenames: ["synthetic.md"] }, operation: "rawRm", manager: "sync", data: removed },
  { route: "page/write", body: { wiki_id: wiki, team_id: "synthetic-team", pages: [{ ref: "synthetic-ref", content: "synthetic-body" }] }, operation: "pageWriteMany", manager: "sync", data: { items: written } },
  { route: "page/rm", body: { wiki_id: wiki, team_id: "synthetic-team", refs: ["synthetic-ref"] }, operation: "pageRm", manager: "sync", data: removed },
] as const;
afterEach(() => vi.restoreAllMocks());
describe("Wiki route manager-failure diagnostics", () => {
  for (const item of cases) {
    for (const failure of [true, false]) {
      it(`${item.route} ${failure ? "contains private manager failure details" : "retains quiet success"}`, async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const service = {
          getById: vi.fn(() => ({ team_id: "synthetic-team" })),
          delete: vi.fn(() => true), rawRm: vi.fn(async () => removed),
          pageWriteMany: vi.fn(() => written), pageRm: vi.fn(async () => removed),
        };
        const managerCall = vi.fn(() => {
          if (failure) throw new Error("https://synthetic.invalid/private?credential=" + detail);
        });
        const manager = { remove: managerCall, sync: managerCall };
        const app = createWikiRoutes({ wikiService: service, wikiMgr: manager, publicBaseUrl: "http://127.0.0.1/v3" } as unknown as WikiRouteDeps);
        const response = await app.request("/" + item.route, {
          method: "POST", headers: { "content-type": "application/json", "x-tdai-service-id": "synthetic-service" },
          body: JSON.stringify(item.body),
        });
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result.code).toBe(0);
        expect(result.data).toEqual(item.data);
        expect(service[item.operation]).toHaveBeenCalledTimes(1);
        expect(managerCall).toHaveBeenCalledWith(wiki);
        expect(warn).toHaveBeenCalledTimes(failure ? 1 : 0);
        const diagnostics = warn.mock.calls.flat().map(String).join("\n");
        expect(diagnostics).not.toContain(wiki);
        expect(diagnostics).not.toContain(detail);
        expect(diagnostics).not.toContain("synthetic.invalid");
      });
    }
  }
});
