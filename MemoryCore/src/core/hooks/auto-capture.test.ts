import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { performAutoCapture } from "./auto-capture.js";

describe("performAutoCapture L0 vector capability", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not embed when the store reports vector search unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdai-auto-capture-"));
    tempDirs.push(dir);
    const embed = vi.fn(async () => new Float32Array([1, 2]));
    const upsertL0 = vi.fn(async () => true);

    const result = await performAutoCapture({
      messages: [{ role: "user", content: "hello", timestamp: 1_000 }],
      sessionKey: "session-vector-disabled",
      cfg: {} as never,
      pluginDataDir: dir,
      vectorStore: {
        supportsDeferredEmbedding: false,
        getCapabilities: () => ({
          vectorSearch: false,
          ftsSearch: true,
          nativeHybridSearch: false,
          sparseVectors: false,
          profileRows: false,
        }),
        upsertL0,
      } as never,
      embeddingService: {
        embed,
        getDimensions: () => 2,
      } as never,
    });

    expect(result.l0RecordedCount).toBe(1);
    expect(result.l0VectorsWritten).toBe(0);
    expect(upsertL0).toHaveBeenCalledOnce();
    expect(upsertL0.mock.calls[0][1]).toBeUndefined();
    expect(embed).not.toHaveBeenCalled();
  });
});
