import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createStorageContext, ensureDirs, readRefMd, writeRefMd } from "./storage.js";

const tempRoots: string[] = [];

async function makeContext() {
  const root = await mkdtemp(join(tmpdir(), "tdai-offload-ref-"));
  tempRoots.push(root);
  const ctx = createStorageContext(root, "agent", "session");
  await ensureDirs(ctx);
  return { root, ctx };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("ref MD storage", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("keeps timestamp-derived ref files inside the refs directory", async () => {
    const { root, ctx } = await makeContext();

    const refPath = await writeRefMd(ctx, "../../escaped", "tool", "content");

    expect(refPath).toMatch(/^refs\//);
    expect(refPath).not.toContain("../");
    expect(await exists(join(root, "escaped.md"))).toBe(false);
    await expect(readRefMd(ctx, refPath)).resolves.toContain("content");
  });

  it("does not read ref paths outside the refs directory", async () => {
    const { root, ctx } = await makeContext();
    await writeFile(join(root, "secret.md"), "secret", "utf-8");

    await expect(readRefMd(ctx, "../secret.md")).resolves.toBeNull();
  });
});
