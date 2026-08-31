import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  createStorageContext,
  ensureDirs,
  readRefMd,
  writeRefMd,
} from "./storage.js";

describe("tool-result refs", () => {
  it("writes collision-resistant refs and reads them through the session context", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "tdai-offload-"));
    try {
      const ctx = createStorageContext(dataRoot, "main", "session-1");
      await ensureDirs(ctx);
      const ref = await writeRefMd(
        ctx,
        "2026-07-06T00:00:00.000Z",
        "exec",
        "TDAI_OFFLOAD_SENTINEL 400",
        "tool-call-1",
      );

      expect(ref).toContain("tool-call-1");
      await expect(readRefMd(ctx, ref)).resolves.toContain("TDAI_OFFLOAD_SENTINEL 400");
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
