import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/client.js";
import { SqliteKnowledgeStore } from "../src/store/sqlite-store.js";
import { createCredentialStore } from "../src/source-auth/credential-store.js";
import { CodeGraphService } from "../src/store/code-graph-service.js";
import { BuildQueue } from "../src/store/build-queue.js";
import { createCodeGraphRoutes, type CodeGraphRouteDeps } from "../src/routes/code-graph.js";

const service = "synthetic-service", team = "synthetic-team", marker = "synthetic-password";
const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); vi.restoreAllMocks(); });
function setup() {
  const { db, raw } = createDb({ path: ":memory:" }); closers.push(() => raw.close());
  const store = new SqliteKnowledgeStore(db), credentialStore = createCredentialStore({ db });
  const writes = vi.spyOn(store, "createCodeGraph"), audit = vi.spyOn(store, "appendCodeGraphAudit"), credentials = vi.spyOn(credentialStore, "put");
  const queue = new BuildQueue(), enqueue = vi.spyOn(queue, "enqueue").mockImplementation(() => {});
  const cgService = new CodeGraphService({ store, credentialStore, queue, dataRoot: "/tmp/synthetic-repo-url", worker: vi.fn(async () => { throw new Error("must not clone"); }) });
  const app = createCodeGraphRoutes({ cgService, instancePool: {}, publicBaseUrl: "" } as unknown as CodeGraphRouteDeps);
  const params = (repo_url: string) => ({ service_id: service, team_id: team, repo_url, branch: "main" });
  const create = (repo_url: string, extra: Record<string, unknown> = {}) => app.request("/create", { method: "POST", headers: { "content-type": "application/json", "x-tdai-service-id": service }, body: JSON.stringify({ team_id: team, repo_url, branch: "main", ...extra }) });
  const count = () => (raw.prepare("SELECT count(*) AS n FROM knowledge_code_graph").get() as { n: number }).n;
  return { store, credentialStore, writes, audit, credentials, enqueue, cgService, params, create, count };
}
const invalid = [
  `https://user:${marker}@synthetic.invalid/repo.git`,
  `https://${marker}@synthetic.invalid/repo.git`,
  `https://:${marker}@synthetic.invalid/repo.git`,
  "https://user:%73ynthetic-password@synthetic.invalid/repo.git",
  `ssh://git:${marker}@synthetic.invalid/repo.git`,
  `https://user:${marker}@`,
  "https://[invalid-host/repo.git",
];
describe("CodeGraph repository metadata credential boundary", () => {
  for (const [i, url] of invalid.entries()) {
    it(`route refuses unsafe URL ${i} before persistence, audit, credentials or enqueue`, async () => {
      const f = setup(); const response = await f.create(url, { provider_id: "synthetic", secret: marker });
      expect(response.status).toBe(400); const body = await response.text(); expect(body).not.toContain(marker); expect(body).not.toContain(url);
      expect(f.writes).not.toHaveBeenCalled(); expect(f.audit).not.toHaveBeenCalled(); expect(f.credentials).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled(); expect(f.count()).toBe(0);
    });
    it(`direct service refuses unsafe URL ${i} before any side effect`, () => {
      const f = setup(); let message = "";
      try { f.cgService.create({ ...f.params(url), credential: { provider_id: "synthetic", secret: marker } }); } catch (error) { message = String(error); }
      expect(message).toMatch(/repository URL/); expect(message).not.toContain(marker); expect(message).not.toContain(url);
      expect(f.writes).not.toHaveBeenCalled(); expect(f.audit).not.toHaveBeenCalled(); expect(f.credentials).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled(); expect(f.count()).toBe(0);
    });
  }
  for (const url of ["https://synthetic.invalid/repo.git", "ssh://git@synthetic.invalid/repo.git", "git@synthetic.invalid:team/repo.git", "/tmp/synthetic-repository"]) {
    it(`retains clean repository form ${url}`, async () => {
      const f = setup(); const response = await f.create(url); expect(response.status).toBe(201);
      const body = await response.json(); expect(body.data.repo_url).toBe(url); expect(f.count()).toBe(1); expect(f.enqueue).toHaveBeenCalledTimes(1);
      const duplicate = f.cgService.create(f.params(url)); expect(duplicate.existed).toBe(true); expect(f.enqueue).toHaveBeenCalledTimes(1);
    });
  }
  it("retains separately stored source credentials without copying them into repository metadata", async () => {
    const f = setup(); const url = "https://synthetic.invalid/repo.git";
    const response = await f.create(url, { provider_id: "synthetic", secret: marker }); expect(response.status).toBe(201);
    const body = await response.json(); expect(JSON.stringify(body)).not.toContain(marker); expect(body.data.repo_url).toBe(url);
    const ref = { type: "code-graph" as const, serviceId: service, resourceId: body.data.code_graph_id };
    expect(f.credentialStore.get(ref)?.secret).toBe(marker); expect(JSON.stringify(f.credentialStore.status(ref))).not.toContain(marker);
    expect(f.store.getCodeGraphById(service, body.data.code_graph_id)?.repo_url).toBe(url); expect(f.enqueue).toHaveBeenCalledTimes(1);
  });
});
