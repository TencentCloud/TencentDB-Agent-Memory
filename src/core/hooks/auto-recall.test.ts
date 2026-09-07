import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseConfig } from "../../config.js";
import type { IMemoryStore, L1FtsResult, StoreCapabilities } from "../store/types.js";
import { performAutoRecall } from "./auto-recall.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-prompt-cache-"));
  tempDirs.push(dir);
  return dir;
}

function ftsResult(id: string, content: string): L1FtsResult {
  return {
    record_id: id,
    content,
    type: "instruction",
    priority: 80,
    scene_name: "cache test",
    score: 0.95,
    timestamp_str: "2026-07-01T01:00:00.000Z",
    timestamp_start: "2026-07-01T01:00:00.000Z",
    timestamp_end: "2026-07-01T01:00:00.000Z",
    session_key: "session-1",
    session_id: "session-1",
    metadata_json: "{}",
  };
}

function createFtsStore(results: L1FtsResult[]): IMemoryStore {
  const capabilities: StoreCapabilities = {
    vectorSearch: false,
    ftsSearch: true,
    nativeHybridSearch: false,
    sparseVectors: false,
  };

  return {
    init: () => ({ needsReindex: false }),
    isDegraded: () => false,
    getCapabilities: () => capabilities,
    close() {},
    isFtsAvailable: () => true,
    searchL1Fts: () => results,
  } as unknown as IMemoryStore;
}

function composeSystemPrompt(params: {
  base: string;
  prepend?: string;
  append?: string;
}): string {
  return [params.prepend, params.base, params.append]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

function commonPrefixLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) index += 1;
  return index;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("performAutoRecall prompt-cache layout", () => {
  it("keeps stable system context ahead of dynamic L1 recall", async () => {
    const dataDir = await makeTempDir();
    await fs.writeFile(
      path.join(dataDir, "persona.md"),
      "# Persona\n\nThe user prefers concise implementation notes.",
      "utf-8",
    );
    const cfg = parseConfig({
      recall: { strategy: "keyword", maxResults: 1, scoreThreshold: 0.1 },
    });

    const result = await performAutoRecall({
      userText: "How should I write the implementation note?",
      actorId: "agent",
      sessionKey: "session-1",
      cfg,
      pluginDataDir: dataDir,
      vectorStore: createFtsStore([
        ftsResult("memory-1", "Include the verification commands."),
      ]),
    });

    expect(result?.prependSystemContext).toContain("<user-persona>");
    expect(result?.prependSystemContext).toContain("<memory-tools-guide>");
    expect(result?.prependSystemContext).not.toContain("<relevant-memories>");
    expect(result?.appendSystemContext).toBeUndefined();
    expect(result?.prependContext).toContain("<relevant-memories>");
    expect(result?.prependContext).toContain("verification commands");
  });

  it("moves the stable memory block into the reusable prefix across turns", async () => {
    const dataDir = await makeTempDir();
    const persona = `# Persona\n\n${"Stable preference and profile context. ".repeat(120)}`;
    await fs.writeFile(path.join(dataDir, "persona.md"), persona, "utf-8");
    const cfg = parseConfig({
      recall: { strategy: "keyword", maxResults: 1, scoreThreshold: 0.1 },
    });

    const first = await performAutoRecall({
      userText: "first query",
      actorId: "agent",
      sessionKey: "session-1",
      cfg,
      pluginDataDir: dataDir,
      vectorStore: createFtsStore([ftsResult("memory-1", "First dynamic memory")]),
    });
    const second = await performAutoRecall({
      userText: "second query",
      actorId: "agent",
      sessionKey: "session-1",
      cfg,
      pluginDataDir: dataDir,
      vectorStore: createFtsStore([ftsResult("memory-2", "Second dynamic memory")]),
    });

    const stable = first?.prependSystemContext;
    expect(stable).toBeDefined();
    expect(second?.prependSystemContext).toBe(stable);
    expect(second?.prependContext).not.toBe(first?.prependContext);

    // OpenClaw composes system context as prepend + base + append. Its base
    // contains a stable section, a cache boundary, then volatile runtime data.
    const basePrefix = "# OpenClaw system\n<!-- CACHE_BOUNDARY -->\n# Runtime\nrequest=";
    const firstBase = `${basePrefix}first`;
    const secondBase = `${basePrefix}second`;

    const legacyFirst = composeSystemPrompt({ base: firstBase, append: stable });
    const legacySecond = composeSystemPrompt({ base: secondBase, append: stable });
    const optimizedFirst = composeSystemPrompt({ base: firstBase, prepend: stable });
    const optimizedSecond = composeSystemPrompt({ base: secondBase, prepend: stable });

    const legacyReusableChars = commonPrefixLength(legacyFirst, legacySecond);
    const optimizedReusableChars = commonPrefixLength(optimizedFirst, optimizedSecond);
    const reusableGain = optimizedReusableChars - legacyReusableChars;

    expect(reusableGain).toBe(stable!.length + 2);
    expect(reusableGain).toBeGreaterThan(4_000);
  });
});
