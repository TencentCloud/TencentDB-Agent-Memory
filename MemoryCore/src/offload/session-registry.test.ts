import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionRegistry } from "./session-registry.js";

const roots: string[] = [];
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-session-registry-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SessionRegistry cold initialization", () => {
  it("shares one initialized manager and its pending buffer across concurrent resolves", async () => {
    const registry = new SessionRegistry(await temporaryRoot());
    const key = "agent:main:session-one";
    const contexts = await Promise.all(Array.from({ length: 8 }, () => registry.resolve(key)));
    expect(new Set(contexts).size).toBe(1);
    expect(registry.size).toBe(1);
    expect(registry.get(key)).toBe(contexts[0]);
    contexts[0].manager.addToolPair({ toolCallId: "call-1", toolName: "read", params: {}, result: "file", timestamp: "2026-10-13T12:00:00.000Z" });
    expect(contexts.every((ctx) => ctx.manager.getPendingCount() === 1)).toBe(true);
    expect(await registry.resolve(key)).toBe(contexts[0]);
  });

  it("retries initialization after a real filesystem error", async () => {
    const parent = await temporaryRoot();
    const dataRoot = join(parent, "data");
    await writeFile(dataRoot, "not a directory");
    const registry = new SessionRegistry(dataRoot);
    const key = "agent:main:retry-session";
    const failed = await Promise.allSettled([registry.resolve(key), registry.resolve(key)]);
    expect(failed.every((result) => result.status === "rejected")).toBe(true);
    expect(registry.size).toBe(0);

    await rm(dataRoot);
    await mkdir(dataRoot);
    const [first, second] = await Promise.all([registry.resolve(key), registry.resolve(key)]);
    expect(first).toBe(second);
    expect(first.manager.ctx.dataRoot).toBe(dataRoot);
    expect(registry.size).toBe(1);
  });

  it("keeps different sessions isolated and bypasses internal memory sessions", async () => {
    const registry = new SessionRegistry(await temporaryRoot());
    const [one, two] = await Promise.all([registry.resolve("agent:main:one"), registry.resolve("agent:main:two")]);
    expect(one.manager).not.toBe(two.manager);
    expect(one.manager.ctx.offloadJsonl).not.toBe(two.manager.ctx.offloadJsonl);
    expect(await registry.resolveIfAllowed("agent:main:memory-task-session-123")).toBeNull();
    expect(registry.size).toBe(2);
  });
});
