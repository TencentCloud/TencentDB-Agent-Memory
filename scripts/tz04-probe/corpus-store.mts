/**
 * Shared sandbox for the tz-04 live probes: a real `VectorStore` in /tmp with
 * a handful of records, plus the corpus file the product reads.
 *
 * The live store is never touched — a measurement probe that needs personal
 * memory to prove itself proves nothing about the code.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../src/core/store/sqlite.js";
import type { EmbeddingService } from "../../src/core/store/embedding.js";
import type { ProbeQuery } from "../../src/gateway/probe.js";

export const OWN = "/repo/own";
export const OTHER = "/repo/other";
const DIMS = 8;

export interface Seed {
  id: string;
  content: string;
  type: "instruction" | "persona" | "episodic";
  projectId: string;
  /** Direction of the record's vector — how close it is to a query. */
  vector: number[];
}

export interface Sandbox {
  dir: string;
  store: VectorStore;
  embedding: EmbeddingService;
  writeCorpus: (queries: ProbeQuery[]) => void;
  cleanup: () => void;
}

function vec(values: number[]): Float32Array {
  const v = new Float32Array(DIMS);
  for (let i = 0; i < values.length && i < DIMS; i++) v[i] = values[i]!;
  return v;
}

/** A store with the given records and an embedding service for one fixed query. */
export async function makeCorpusStore(
  prefix: string,
  seeds: Seed[],
  queryVector: number[] = [1, 0, 0, 0, 0, 0, 0, 0],
): Promise<Sandbox> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const store = new VectorStore(path.join(dir, "vectors.db"), DIMS);
  await store.init();
  for (const seed of seeds) {
    await store.upsertL1(
      {
        id: seed.id,
        content: seed.content,
        type: seed.type,
        priority: 50,
        scene_name: "s",
        source_message_ids: [],
        metadata: {},
        timestamps: ["2026-08-13T00:00:00.000Z"],
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-13T00:00:00.000Z",
        sessionKey: "probe",
        sessionId: "probe",
        projectId: seed.projectId,
        scope: "project",
      } as never,
      vec(seed.vector),
    );
  }
  return {
    dir,
    store,
    embedding: {
      embed: async () => vec(queryVector),
    } as unknown as EmbeddingService,
    writeCorpus: (queries) =>
      fs.writeFileSync(
        path.join(dir, "probe-corpus.json"),
        JSON.stringify({ queries }, null, 2),
        "utf-8",
      ),
    cleanup: () => {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
