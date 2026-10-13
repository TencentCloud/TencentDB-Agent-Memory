import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStorageContext, ensureDirs, registerSession, lookupSessionId, listRegisteredSessions } from "../src/offload/storage.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture(body?: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "offload-registry-")); roots.push(root);
  const ctx = createStorageContext(root, "synthetic-agent", "synthetic-session"); await ensureDirs(ctx);
  const file = path.join(ctx.dataDir, "sessions-registry.json"); if (body !== undefined) await fs.writeFile(file, body);
  return { ctx, file };
}
describe("offload registry integrity", () => {
  it.each(["{synthetic-corrupt-record", "[{\"sessionId\":\"synthetic-old\"}]"])("rejects unusable registry without replacing bytes: %s", async body => {
    const f = await fixture(body);
    await expect(registerSession(f.ctx, "agent:synthetic-agent:new", "new")).rejects.toThrow("Offload session registry unavailable or invalid");
    expect(await fs.readFile(f.file, "utf8")).toBe(body);
  });
  it("persists prototype-named keys as ordinary own entries", async () => {
    const f = await fixture(); await registerSession(f.ctx, "__proto__", "synthetic-prototype-session");
    const data = JSON.parse(await fs.readFile(f.file, "utf8"));
    expect(Object.hasOwn(data, "__proto__")).toBe(true);
    expect(await lookupSessionId(f.ctx, "__proto__")).toBe("synthetic-prototype-session");
    expect(Object.hasOwn(Object.prototype, "sessionId")).toBe(false);
  });
  it("keeps the authoritative map key when a row contains a conflicting sessionKey", async () => {
    const f = await fixture(JSON.stringify({ "agent:synthetic-agent:real": { sessionKey: "synthetic-forged-key", sessionId: "real", extra: "preserved" } }));
    expect(await listRegisteredSessions(f.ctx)).toEqual([{ sessionKey: "agent:synthetic-agent:real", sessionId: "real", extra: "preserved" }]);
  });
  it("does not return a numeric session ID through the string API", async () => {
    const f = await fixture(JSON.stringify({ synthetic: { sessionId: 42 } }));
    expect(await lookupSessionId(f.ctx, "synthetic")).toBeNull();
  });
  it("does not return escaping session IDs from persisted metadata", async () => {
    const f = await fixture(JSON.stringify({ synthetic: { sessionId: "x/../../outside" } }));
    expect(await lookupSessionId(f.ctx, "synthetic")).toBeNull();
  });
  it("does not enumerate array positions as registered session keys", async () => {
    const f = await fixture(JSON.stringify([{ sessionId: "synthetic-array-row" }]));
    expect(await listRegisteredSessions(f.ctx)).toEqual([]);
  });
  it("keeps prior valid records and supports normal Unicode registration/lookup/list", async () => {
    const prior = { "agent:synthetic-agent:old": { sessionId: "old", extra: "preserved" } };
    const f = await fixture(JSON.stringify(prior)); await registerSession(f.ctx, "agent:synthetic-agent:żółć", "żółć");
    const data = JSON.parse(await fs.readFile(f.file, "utf8")); expect(data["agent:synthetic-agent:old"]).toEqual(prior["agent:synthetic-agent:old"]);
    expect(await lookupSessionId(f.ctx, "agent:synthetic-agent:żółć")).toBe("żółć"); expect(await lookupSessionId(f.ctx, "missing")).toBeNull();
    expect(await listRegisteredSessions(f.ctx)).toHaveLength(2);
  });
});
