import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  createStorageContext,
  ensureDirs,
  readRefMdFromDataDir,
  writeRefMd,
} from "./storage.js";

describe("readRefMdFromDataDir", () => {
  it("reads a safe ref from an agent data directory without a session manager", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "tdai-offload-"));
    try {
      const ctx = createStorageContext(dataRoot, "main", "session-1");
      await ensureDirs(ctx);
      const ref = await writeRefMd(ctx, "2026-07-06T00:00:00.000Z", "exec", "TDAI_OFFLOAD_SENTINEL 400");

      await expect(readRefMdFromDataDir(ctx.dataDir, ref)).resolves.toContain("TDAI_OFFLOAD_SENTINEL 400");
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
