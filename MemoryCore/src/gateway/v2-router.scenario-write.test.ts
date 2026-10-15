/**
 * Unit tests for POST /v3/scenario/write create-vs-update behavior.
 *
 * Regression coverage for issue #1629: the endpoint used to early-return 404
 * when the target path did not exist (update-only), contradicting the v3 API
 * doc write contract and leaving the META-rebuild branch unreachable. The
 * endpoint is an upsert: missing path → create with fresh META
 * (created = updated = now), existing path → update (created preserved,
 * updated/summary refreshed, output unchanged from the historical algorithm).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { handleScenarioWrite, type V2RouterDeps } from "./v2-router.js";
import { StorageAdapter } from "../core/storage/adapter.js";
import { LocalStorageBackend } from "../core/storage/local-backend.js";
import type { V2AuthContext } from "./v2-schemas.js";
import type { Logger } from "../core/types.js";

const FROZEN_NOW = "2026-10-12T00:00:00.000Z";

const fakeLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const tempRoots: string[] = [];
let rootDir: string;
let storage: StorageAdapter;

function makeDeps(): V2RouterDeps {
  return {
    getStore: () => undefined,
    getEmbedding: () => undefined,
    getStorage: () => storage,
    logger: fakeLogger,
    deployMode: "standalone",
  } as V2RouterDeps;
}

async function writeRaw(key: string, content: string): Promise<void> {
  await storage.writeFile(key, content);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(FROZEN_NOW));
  rootDir = await mkdtemp(join(tmpdir(), "tdbam-scenario-write-"));
  tempRoots.push(rootDir);
  storage = new StorageAdapter(new LocalStorageBackend(rootDir));
});

afterAll(async () => {
  vi.useRealTimers();
  await Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("handleScenarioWrite (POST /v3/scenario/write)", () => {
  it("creates a new L2 block with fresh META when the path does not exist (upsert per doc contract)", async () => {
    const body = { path: "notes/created-by-test.md", content: "probe line", summary: "issue repro" };

    const res = await handleScenarioWrite(body, {} as V2AuthContext, "req-create-1", makeDeps());

    expect(res.code).toBe(0);
    expect(res.request_id).toBe("req-create-1");
    expect(res.data).toMatchObject({
      path: "notes/created-by-test.md",
      version: 0,
      updated_at: FROZEN_NOW,
    });

    const stored = await storage.readFile("scene_blocks/notes/created-by-test.md");
    expect(stored).not.toBeNull();
    expect(stored).toBe(
      "-----META-START-----\n" +
      `created: ${FROZEN_NOW}\n` +
      `updated: ${FROZEN_NOW}\n` +
      "summary: issue repro\n" +
      "-----META-END-----\n\n" +
      "probe line",
    );
  });

  it("create without summary emits created + updated only", async () => {
    const res = await handleScenarioWrite(
      { path: "notes/no-summary.md", content: "body only" },
      {} as V2AuthContext,
      "req-create-2",
      makeDeps(),
    );

    expect(res.code).toBe(0);
    const stored = await storage.readFile("scene_blocks/notes/no-summary.md");
    expect(stored).toBe(
      "-----META-START-----\n" +
      `created: ${FROZEN_NOW}\n` +
      `updated: ${FROZEN_NOW}\n` +
      "-----META-END-----\n\n" +
      "body only",
    );
  });

  it("update of an existing block preserves created and refreshes updated/summary (byte-identical to historical output)", async () => {
    await writeRaw(
      "scene_blocks/notes/old.md",
      "-----META-START-----\n" +
      "created: 2026-01-01T00:00:00.000Z\n" +
      "updated: 2026-02-02T00:00:00.000Z\n" +
      "summary: old summary\n" +
      "-----META-END-----\n\n" +
      "old body",
    );

    const res = await handleScenarioWrite(
      { path: "notes/old.md", content: "new body", summary: "new summary" },
      {} as V2AuthContext,
      "req-update-1",
      makeDeps(),
    );

    expect(res.code).toBe(0);
    expect(res.data).toMatchObject({
      path: "notes/old.md",
      version: 0,
      updated_at: FROZEN_NOW,
    });

    const stored = await storage.readFile("scene_blocks/notes/old.md");
    expect(stored).toBe(
      "-----META-START-----\n" +
      "created: 2026-01-01T00:00:00.000Z\n" +
      `updated: ${FROZEN_NOW}\n` +
      "summary: new summary\n" +
      "-----META-END-----\n\n" +
      "new body",
    );
  });

  it("update without summary keeps the previous summary", async () => {
    await writeRaw(
      "scene_blocks/notes/keep-summary.md",
      "-----META-START-----\n" +
      "created: 2026-01-01T00:00:00.000Z\n" +
      "updated: 2026-02-02T00:00:00.000Z\n" +
      "summary: keep me\n" +
      "-----META-END-----\n\n" +
      "old body",
    );

    const res = await handleScenarioWrite(
      { path: "notes/keep-summary.md", content: "new body" },
      {} as V2AuthContext,
      "req-update-2",
      makeDeps(),
    );

    expect(res.code).toBe(0);
    const stored = await storage.readFile("scene_blocks/notes/keep-summary.md");
    expect(stored).toBe(
      "-----META-START-----\n" +
      "created: 2026-01-01T00:00:00.000Z\n" +
      `updated: ${FROZEN_NOW}\n` +
      "summary: keep me\n" +
      "-----META-END-----\n\n" +
      "new body",
    );
  });

  it("rebuilds META (created = updated = now) when an existing file has no META block", async () => {
    await writeRaw("scene_blocks/notes/bare.md", "raw body without meta");

    const res = await handleScenarioWrite(
      { path: "notes/bare.md", content: "rewritten", summary: "rebuilt" },
      {} as V2AuthContext,
      "req-rebuild-1",
      makeDeps(),
    );

    expect(res.code).toBe(0);
    const stored = await storage.readFile("scene_blocks/notes/bare.md");
    expect(stored).toBe(
      "-----META-START-----\n" +
      `created: ${FROZEN_NOW}\n` +
      `updated: ${FROZEN_NOW}\n` +
      "summary: rebuilt\n" +
      "-----META-END-----\n\n" +
      "rewritten",
    );
  });

  it("rejects an invalid path with 400", async () => {
    const res = await handleScenarioWrite(
      { path: "../escape.md", content: "x" },
      {} as V2AuthContext,
      "req-invalid-1",
      makeDeps(),
    );
    expect(res.code).toBe(400);
  });
});
