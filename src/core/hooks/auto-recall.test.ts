import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseConfig } from "../../config.js";
import type { IMemoryStore, L1FtsResult } from "../store/types.js";
import { performAutoRecall } from "./auto-recall.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("performAutoRecall prompt-cache shape", () => {
  it("keeps stable persona/scene/tools separate from dynamic L1 recall", async () => {
    const pluginDataDir = await makePluginDataDir();
    const cfg = parseConfig({ recall: { strategy: "keyword" } });

    const first = await performAutoRecall({
      userText: "TypeScript prompt cache",
      actorId: "default_user",
      sessionKey: "session-a",
      cfg,
      pluginDataDir,
      vectorStore: makeFtsStore([
        ftsResult("m1", "用户正在优化 TypeScript prompt cache 方案。"),
      ]),
    });

    const second = await performAutoRecall({
      userText: "TypeScript prompt cache",
      actorId: "default_user",
      sessionKey: "session-a",
      cfg,
      pluginDataDir,
      vectorStore: makeFtsStore([
        ftsResult("m2", "用户本轮关注 showInjected 历史膨胀。"),
      ]),
    });

    expect(first?.appendSystemContext).toContain("<user-persona>");
    expect(first?.appendSystemContext).toContain("<scene-navigation>");
    expect(first?.appendSystemContext).toContain("<memory-tools-guide>");
    expect(first?.appendSystemContext).not.toContain("<relevant-memories>");
    expect(first?.prependContext).toContain("<relevant-memories>");
    expect(first?.prependContext).toContain("TypeScript prompt cache");
    expect(first?.appendContext).toBeUndefined();

    expect(second?.appendSystemContext).toBe(first?.appendSystemContext);
    expect(second?.prependContext).toContain("showInjected 历史膨胀");
    expect(second?.prependContext).not.toBe(first?.prependContext);
  });

  it("supports append-mode dynamic recall without moving it into stable system context", async () => {
    const pluginDataDir = await makePluginDataDir();
    const cfg = parseConfig({ recall: { strategy: "keyword", injectionMode: "append" } });

    const result = await performAutoRecall({
      userText: "append context cache",
      actorId: "default_user",
      sessionKey: "session-a",
      cfg,
      pluginDataDir,
      vectorStore: makeFtsStore([
        ftsResult("m1", "appendContext 可以避免改写用户 prompt 前缀。"),
      ]),
    });

    expect(result?.prependContext).toBeUndefined();
    expect(result?.appendContext).toContain("<relevant-memories>");
    expect(result?.appendContext).toContain("appendContext");
    expect(result?.appendSystemContext).toContain("<memory-tools-guide>");
    expect(result?.appendSystemContext).not.toContain("<relevant-memories>");
  });

  it("applies recall budgets before append-mode injection", async () => {
    const pluginDataDir = await makePluginDataDir();
    const cfg = parseConfig({
      recall: {
        strategy: "keyword",
        injectionMode: "append",
        maxCharsPerMemory: 120,
        maxTotalRecallChars: 120,
      },
    });

    const result = await performAutoRecall({
      userText: "budgeted recall",
      actorId: "default_user",
      sessionKey: "session-a",
      cfg,
      pluginDataDir,
      vectorStore: makeFtsStore([
        ftsResult("m1", "第一条非常长的召回记忆 ".repeat(20)),
        ftsResult("m2", "second recall payload should be dropped"),
      ]),
    });

    expect(result?.appendContext).toContain("已截断");
    expect(result?.appendContext).not.toContain("second recall payload");
    expect(result?.prependContext).toBeUndefined();
  });
});

async function makePluginDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-recall-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, ".metadata"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "persona.md"),
    "## User Persona\n用户偏好可复核的工程证据。\n",
    "utf-8",
  );
  await fs.writeFile(
    path.join(dir, ".metadata", "scene_index.json"),
    JSON.stringify([
      {
        filename: "prompt-cache.md",
        summary: "Prompt cache stability work",
        heat: 42,
        created: "2026-07-01T00:00:00+08:00",
        updated: "2026-07-02T00:00:00+08:00",
      },
    ]),
    "utf-8",
  );
  return dir;
}

function makeFtsStore(results: L1FtsResult[]): IMemoryStore {
  return {
    isFtsAvailable: () => true,
    searchL1Fts: () => results,
    getCapabilities: () => ({
      vectorSearch: false,
      ftsSearch: true,
      nativeHybridSearch: false,
      sparseVectors: false,
    }),
  } as unknown as IMemoryStore;
}

function ftsResult(id: string, content: string): L1FtsResult {
  return {
    record_id: id,
    content,
    type: "persona",
    priority: 80,
    scene_name: "prompt-cache",
    score: 1,
    timestamp_str: "2026-07-02T10:00:00+08:00",
    timestamp_start: "2026-07-02T10:00:00+08:00",
    timestamp_end: "2026-07-02T10:00:00+08:00",
    session_key: "session-a",
    session_id: "session-a",
    metadata_json: "{}",
  };
}
