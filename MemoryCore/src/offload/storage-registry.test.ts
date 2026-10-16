import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStorageContext, ensureDirs, listRegisteredSessions, lookupSessionId, registerSession } from "./storage.js";

const roots: string[] = [];
async function context(agent = "main") {
  const root = await mkdtemp(join(tmpdir(), "memory-offload-registry-"));
  roots.push(root);
  const ctx = createStorageContext(root, agent, "session-one");
  await ensureDirs(ctx);
  return ctx;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("offload session registry persistence", () => {
  it("retains every mapping registered concurrently for the same agent", async () => {
    const ctx = await context();
    await registerSession(ctx, "agent:main:existing", "real-existing");
    const keys = Array.from({ length: 20 }, (_, i) => `agent:main:session-${i}`);
    await Promise.all(keys.map((key, i) => registerSession(ctx, key, `real-${i}`)));
    const saved = await listRegisteredSessions(ctx);
    expect(saved.map((entry) => entry.sessionKey).sort()).toEqual(["agent:main:existing", ...keys].sort());
    expect(await lookupSessionId(ctx, "agent:main:existing")).toBe("real-existing");
    for (const [i, key] of keys.entries()) {
      expect(await lookupSessionId(ctx, key)).toBe(`real-${i}`);
    }
  });

  it("allows registration after an earlier filesystem write failure", async () => {
    const ctx = await context();
    const registryPath = join(ctx.dataDir, "sessions-registry.json");
    await mkdir(registryPath);
    await expect(registerSession(ctx, "agent:main:first", "real-first")).rejects.toThrow();
    await rm(registryPath, { recursive: true });
    await registerSession(ctx, "agent:main:retry", "real-retry");
    expect(await lookupSessionId(ctx, "agent:main:retry")).toBe("real-retry");
  });

  it("keeps agents isolated and permits replacing one session's mapping", async () => {
    const one = await context("one");
    const two = createStorageContext(one.dataRoot, "two", "session-two");
    await ensureDirs(two);
    await Promise.all([registerSession(one, "shared-key", "first"), registerSession(two, "shared-key", "second")]);
    await registerSession(one, "shared-key", "replacement");
    expect(await lookupSessionId(one, "shared-key")).toBe("replacement");
    expect(await lookupSessionId(two, "shared-key")).toBe("second");
  });
});
