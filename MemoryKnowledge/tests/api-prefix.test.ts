import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/server.js";

const apps: ReturnType<typeof createApp>[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function makeApp(apiPrefix: string) {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-prefix-"));
  dirs.push(dir);
  const instance = createApp({ apiPrefix, dataDir: dir, dbPath: join(dir, "knowledge.db"),
    auth: { serviceKey: "synthetic-key", allowInsecureNoKeyListen: false } });
  apps.push(instance);
  return instance;
}

describe("API prefix authentication and canonical routing", () => {
  it.each(["/", "", "/v3/*", "/v3?key=x", "/v3#fragment", "/v3/:tenant", "/v3/{tenant}",
    "/v3/%2f", "/v3/..", "/v3//nested", "/v3/a b", "/v3/\\nested"])(
    "rejects unsupported prefix %j before opening a database", (prefix) => {
      expect(() => makeApp(prefix)).toThrow(/API_PREFIX/);
      expect(existsSync(join(dirs.at(-1)!, "knowledge.db"))).toBe(false);
    });

  it.each(["/v3/", "api/knowledge/", "/custom-prefix"])(
    "protects the real normalized route for %j", async (prefix) => {
      const { app, config } = makeApp(prefix);
      const path = `${config.apiPrefix}/wiki/list`;
      for (const token of [undefined, "wrong-key"]) {
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>({ pull(controller) {
          pulls++;
          controller.enqueue(new TextEncoder().encode('{"team_id":"synthetic-team"}'));
          controller.close();
        } }, { highWaterMark: 0 });
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (token) headers.authorization = `Bearer ${token}`;
        const init: RequestInit & { duplex: "half" } = { method: "POST", headers, body, duplex: "half" };
        const request = new Request(`http://localhost${path}`, init);
        expect((await app.fetch(request)).status).toBe(401);
        expect(pulls).toBe(0);
        expect(request.bodyUsed).toBe(false);
      }
      const response = await app.request(path, { method: "POST", headers: {
        "authorization": "Bearer synthetic-key", "content-type": "application/json",
        "x-tdai-service-id": "synthetic-service",
      }, body: '{"team_id":"synthetic-team"}' });
      expect(response.status).toBe(200);
      expect((await app.request("/health")).status).toBe(200);

      // The same normalized prefix must retain the OKF transport limit.
      const oversized = await app.request(`${config.apiPrefix}/wiki/okf/import`, {
        method: "POST", headers: { "authorization": "Bearer synthetic-key",
          "content-length": String(20 * 1024 * 1024 + 1) }, body: "x",
      });
      expect(oversized.status).toBe(413);
    });
});
