import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createDb } from "../src/db/client.js";
import { SqliteKnowledgeStore } from "../src/store/sqlite-store.js";
import { createCredentialStore } from "../src/source-auth/credential-store.js";
import { createServiceAuthMiddleware } from "../src/middleware/auth.js";
import { createWikiSourceRoutes, type WikiSourceRouteDeps } from "../src/wiki-source/routes.js";

const service = "synthetic-service";
const team = "synthetic-team";
const wiki = "synthetic-wiki";

function setup() {
  const store = {
    getWikiById: vi.fn((s: string, id: string) => s === service && id === wiki ? { team_id: team } : undefined),
  };
  const credentialStore = {
    get: vi.fn(() => ({ secret: "synthetic-secret" })),
    status: vi.fn(() => ({ provider_id: "synthetic-provider" })),
  };
  const provider = {
    resolveRoot: vi.fn(async () => ({
      rootType: "doc", rootId: "synthetic-document", displayName: "synthetic-title", estimatedCount: 1,
    })),
    listPages: vi.fn(async () => []),
  };
  const registry = { contextFor: vi.fn(() => ({ provider, ctx: {} })) };
  const wikiService = { rawWriteMany: vi.fn(() => []) };
  const app = createWikiSourceRoutes({ store, credentialStore, registry, wikiService } as unknown as WikiSourceRouteDeps);
  async function post(route: string, headers: Record<string, string> = {}, body: Record<string, unknown> = {}) {
    return app.request("/" + route, {
      method: "POST",
      headers: {
        "content-type": "application/json", "x-tdai-service-id": service,
        "x-tdai-team-id": team, "x-tdai-user-id": "synthetic-user", ...headers,
      },
      body: JSON.stringify({
        wiki_id: wiki, provider_id: "synthetic-provider",
        source_url: "https://synthetic.invalid/p/document", page_ids: [], ...body,
      }),
    });
  }
  return { store, credentialStore, registry, provider, wikiService, post };
}

describe("Wiki source ownership before credential use", () => {
  for (const route of ["list", "import"]) {
    for (const mode of ["foreign-team", "missing-resource", "foreign-service", "body-team-spoof"]) {
      it(`${route} refuses ${mode} before credential/provider access`, async () => {
        const fixture = setup();
        const headers: Record<string, string> = mode === "foreign-team" || mode === "body-team-spoof"
          ? { "x-tdai-team-id": "synthetic-other-team" }
          : mode === "foreign-service" ? { "x-tdai-service-id": "synthetic-other-service" } : {};
        const body = mode === "missing-resource" ? { wiki_id: "synthetic-missing" }
          : mode === "body-team-spoof" ? { team_id: team } : {};
        const response = await fixture.post(route, headers, body);
        expect(response.status).toBe(200); // Preserve this route's code-envelope contract.
        const result = await response.json();
        expect(result.code).toBe(404);
        expect(result.message).toBe("resource not found");
        expect(fixture.credentialStore.get).not.toHaveBeenCalled();
        expect(fixture.credentialStore.status).not.toHaveBeenCalled();
        expect(fixture.registry.contextFor).not.toHaveBeenCalled();
        expect(fixture.provider.resolveRoot).not.toHaveBeenCalled();
        expect(fixture.wikiService.rawWriteMany).not.toHaveBeenCalled();
      });
    }
    it(`${route} retains same-service/team behavior`, async () => {
      const fixture = setup();
      const result = await (await fixture.post(route)).json();
      expect(result.code).toBe(0);
      expect(fixture.credentialStore.get).toHaveBeenCalledTimes(1);
      expect(fixture.provider.resolveRoot).toHaveBeenCalledTimes(1);
    });
    it(`${route} rejects invalid identity before credential use`, async () => {
      const fixture = setup();
      const result = await (await fixture.post(route, { "x-tdai-user-id": "" })).json();
      expect(result.code).toBe(401);
      expect(fixture.credentialStore.get).not.toHaveBeenCalled();
    });
    it(`${route} rejects invalid wiki ID before credential use`, async () => {
      const fixture = setup();
      const result = await (await fixture.post(route, {}, { wiki_id: "../invalid" })).json();
      expect(result.code).toBe(400);
      expect(fixture.credentialStore.get).not.toHaveBeenCalled();
    });
  }
});

const databases: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const raw of databases.splice(0)) raw.close();
});

describe("Mounted Wiki source ownership with native SQLite and real credential store", () => {
  for (const route of ["list", "import"]) {
    for (const owner of [true, false]) {
      it(`${route} ${owner ? "accepts the owner" : "rejects another team"}`, async () => {
        const { db, raw } = createDb({ path: ":memory:" });
        databases.push(raw);
        const key = "synthetic-shared-service-key";
        const store = new SqliteKnowledgeStore(db);
        const credentials = createCredentialStore({ db });
        const row = store.createWiki({ service_id: service, team_id: team, name: "synthetic-native-wiki" }).row;
        credentials.put({ type: "wiki", serviceId: service, resourceId: row.wiki_id }, {
          kind: "bearer", secret: "synthetic-resource-secret",
        }, "synthetic-provider");
        const get = vi.spyOn(credentials, "get");
        const context = vi.fn(() => ({
          provider: {
            resolveRoot: async () => ({ rootType: "doc", rootId: "synthetic-document", displayName: "synthetic-title", estimatedCount: 1 }),
            listPages: async () => [],
          },
          ctx: { endpoint: "https://synthetic.invalid", secret: "synthetic-resource-secret" },
        }));
        const app = new Hono();
        app.use("*", createServiceAuthMiddleware({ serviceKey: key }, "/v3"));
        app.route("/v3/wiki-source", createWikiSourceRoutes({
          store, credentialStore: credentials, registry: { contextFor: context }, wikiService: { rawWriteMany: () => [] },
        } as unknown as WikiSourceRouteDeps));
        const response = await app.request("/v3/wiki-source/" + route, {
          method: "POST",
          headers: {
            authorization: "Bearer " + key, "content-type": "application/json",
            "x-tdai-service-id": service, "x-tdai-team-id": owner ? team : "synthetic-other-team",
            "x-tdai-user-id": "synthetic-user",
          },
          body: JSON.stringify({ wiki_id: row.wiki_id, provider_id: "synthetic-provider", source_url: "https://synthetic.invalid/p/document", page_ids: [] }),
        });
        const result = await response.json();
        expect(result.code).toBe(owner ? 0 : 404);
        expect(get).toHaveBeenCalledTimes(owner ? 1 : 0);
        expect(context).toHaveBeenCalledTimes(owner ? 1 : 0);
      });
    }
  }
});
