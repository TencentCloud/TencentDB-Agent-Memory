import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { VectorStore } from "./memory-store.js";

describe("VectorStore vec0 integrity", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("disables vector search when orphan chunk blobs make writes unsafe", () => {
    const dir = mkdtempSync(join(tmpdir(), "tdai-vec-integrity-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "vectors.db");

    const initial = new VectorStore(dbPath, 2);
    try {
      initial.init();
      expect(initial.getCapabilities().vectorSearch).toBe(true);
    } finally {
      initial.close();
    }

    const db = new DatabaseSync(dbPath, { allowExtension: true });
    db.prepare("INSERT INTO l0_vec_vector_chunks00(rowid, vectors) VALUES (?, ?)").run(
      99,
      Buffer.alloc(16),
    );
    db.prepare("INSERT INTO l0_vec_metadatachunks00(rowid, data) VALUES (?, ?)").run(
      99,
      Buffer.alloc(16),
    );
    db.close();

    const errors: string[] = [];
    const reopened = new VectorStore(dbPath, 2, {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message: string) => errors.push(message),
    } as never);

    try {
      reopened.init();

      expect(errors.some((message) => message.includes("orphan"))).toBe(true);
      expect(reopened.getCapabilities().vectorSearch).toBe(false);
      expect(reopened.supportsDeferredEmbedding).toBe(false);
      expect(reopened.getCapabilities().ftsSearch).toBe(true);
      expect(reopened.isDegraded()).toBe(false);
    } finally {
      reopened.close();
    }
  });
});
