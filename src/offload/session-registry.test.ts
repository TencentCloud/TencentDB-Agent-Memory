import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionRegistry } from "./session-registry.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tdai-offload-registry-"));
  tempRoots.push(root);
  return root;
}

function expectInside(parent: string, child: string): void {
  const rel = relative(parent, child);
  expect(rel).not.toBe("");
  expect(rel.startsWith("..")).toBe(false);
  expect(rel).not.toMatch(/^([A-Za-z]:)?[/\\]/);
}

describe("SessionRegistry", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("keeps host-provided session ids inside the agent storage directory", async () => {
    const root = await makeTempRoot();
    const registry = new SessionRegistry(root);

    const entry = await registry.resolve("agent:main:safe-session", "../../../../escaped");

    expectInside(root, entry.manager.ctx.dataDir);
    expectInside(entry.manager.ctx.dataDir, entry.manager.ctx.offloadJsonl);
    expect(entry.manager.ctx.offloadJsonl).toContain("offload-");
    expect(entry.manager.ctx.offloadJsonl).not.toContain("../");
  });

  it("sanitizes fallback session keys before building storage paths", async () => {
    const root = await makeTempRoot();
    const registry = new SessionRegistry(root);

    const entry = await registry.resolve("..");

    expectInside(root, entry.manager.ctx.dataDir);
    expect(entry.manager.ctx.agentName).not.toBe("..");
  });
});
