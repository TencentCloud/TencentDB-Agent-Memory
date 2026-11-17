/**
 * Write-path coverage for the summary governor:
 *   - the surgical clamp keeps everything but the `summary:` line byte-identical
 *   - the persistence helper is atomic on local fs and bails out (compare-and-set)
 *     when the scene file was rewritten between read and write
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StorageAdapter } from "../storage/adapter.js";
import type { IStorageBackend, ListEntry, ListResult, StorageObject } from "../storage/types.js";
import { clampSummaryInSceneFile } from "./scene-summary.js";
import { writeSceneFileIfUnchanged } from "./scene-file-store.js";

const LONG_SUMMARY =
  "用户在后端开发中偏好 Python 异步框架，近期开始接触 Rust 的所有权模型，反复讨论内存安全与零拷贝解析，" +
  "同时明确拒绝了打补丁式的临时方案，坚持彻底解耦；此外还记录了部署环境的若干约束，包括容器镜像体积上限与启动时间要求。";

const BODY = "## 用户核心特征\n\n一段连贯的正文，必须保持原样。\n";

function sceneFile(summary: string, eol = "\n"): string {
  return [
    "-----META-START-----",
    "created: 2026-01-01T00:00:00.000Z",
    "updated: 2026-02-02T00:00:00.000Z",
    `summary: ${summary}`,
    "heat: 4",
    "-----META-END-----",
    "",
    BODY,
  ].join(eol);
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as never;

class MemoryBackend implements IStorageBackend {
  readonly type = "local" as const;
  readonly store = new Map<string, string>();

  async putObject(key: string, content: string | Buffer): Promise<void> {
    this.store.set(key, content.toString());
  }
  async appendObject(key: string, content: string | Buffer): Promise<void> {
    this.store.set(key, (this.store.get(key) ?? "") + content.toString());
  }
  async getObject(key: string): Promise<StorageObject | null> {
    const value = this.store.get(key);
    if (value === undefined) return null;
    return { key, content: Buffer.from(value, "utf-8"), size: Buffer.byteLength(value) };
  }
  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }
  async listObjects(prefix: string): Promise<ListResult> {
    const entries: ListEntry[] = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => ({ key: k, size: 0, lastModified: new Date(0), isDirectory: false }));
    return { entries };
  }
  async deleteObject(key: string): Promise<void> {
    this.store.delete(key);
  }
  async deleteByPrefix(prefix: string): Promise<number> {
    let removed = 0;
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

describe("clampSummaryInSceneFile", () => {
  it("changes only the summary line", () => {
    const raw = sceneFile(LONG_SUMMARY);
    const { content, changed } = clampSummaryInSceneFile(raw);
    expect(changed).toBe(true);
    expect(content.split("\n").length).toBe(raw.split("\n").length);
    for (const line of [
      "created: 2026-01-01T00:00:00.000Z",
      "updated: 2026-02-02T00:00:00.000Z",
      "heat: 4",
      "## 用户核心特征",
      "一段连贯的正文，必须保持原样。",
    ]) {
      expect(content).toContain(line);
    }
    const summaryLine = content.split("\n").find((l) => l.startsWith("summary: "))!;
    expect(summaryLine.length).toBeLessThan(LONG_SUMMARY.length);
  });

  it("is idempotent", () => {
    const first = clampSummaryInSceneFile(sceneFile(LONG_SUMMARY));
    const second = clampSummaryInSceneFile(first.content);
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it("does not touch a file that is already within limits", () => {
    const raw = sceneFile("用户偏好 Python 异步后端。");
    expect(clampSummaryInSceneFile(raw)).toEqual({ content: raw, changed: false });
  });

  it("does not touch a file without META", () => {
    const raw = `# 场景\n\nsummary: ${LONG_SUMMARY}\n`;
    expect(clampSummaryInSceneFile(raw)).toEqual({ content: raw, changed: false });
  });
});

describe("local fs persistence", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-scene-summary-"));
    await fs.mkdir(path.join(dataDir, "scene_blocks"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("writes atomically and leaves no temp file behind", async () => {
    const abs = path.join(dataDir, "scene_blocks", "a.md");
    const raw = sceneFile(LONG_SUMMARY);
    await fs.writeFile(abs, raw, "utf-8");

    const next = clampSummaryInSceneFile(raw);
    expect(next.changed).toBe(true);

    await expect(
      writeSceneFileIfUnchanged("a.md", raw, next.content, { dataDir, logger: silentLogger }),
    ).resolves.toBe(true);

    expect(await fs.readFile(abs, "utf-8")).toBe(next.content);
    const leftovers = (await fs.readdir(path.join(dataDir, "scene_blocks"))).filter((f) =>
      f.includes(".tmp-"),
    );
    expect(leftovers).toEqual([]);
  });

  it("refuses to write when the file changed since it was read", async () => {
    const abs = path.join(dataDir, "scene_blocks", "b.md");
    const stale = sceneFile(LONG_SUMMARY);
    const concurrent = sceneFile("并发写入后的新正文摘要。");
    await fs.writeFile(abs, concurrent, "utf-8");

    await expect(
      writeSceneFileIfUnchanged("b.md", stale, "SHOULD NOT BE WRITTEN", {
        dataDir,
        logger: silentLogger,
      }),
    ).resolves.toBe(false);
    expect(await fs.readFile(abs, "utf-8")).toBe(concurrent);
  });

  it("returns false instead of throwing when the file disappeared", async () => {
    await expect(
      writeSceneFileIfUnchanged("missing.md", "x", "y", { dataDir, logger: silentLogger }),
    ).resolves.toBe(false);
  });
});

describe("service (storage adapter) persistence", () => {
  it("writes through the scene_blocks/ key prefix", async () => {
    const backend = new MemoryBackend();
    const storage = new StorageAdapter(backend);
    const raw = sceneFile(LONG_SUMMARY);
    backend.store.set("scene_blocks/c.md", raw);

    const next = clampSummaryInSceneFile(raw);
    await expect(
      writeSceneFileIfUnchanged("c.md", raw, next.content, {
        dataDir: "/unused",
        storage,
        logger: silentLogger,
      }),
    ).resolves.toBe(true);
    expect(backend.store.get("scene_blocks/c.md")).toBe(next.content);
  });

  it("skips the write when another session rewrote the object", async () => {
    const backend = new MemoryBackend();
    const storage = new StorageAdapter(backend);
    const stale = sceneFile(LONG_SUMMARY);
    const concurrent = sceneFile("另一个 session 刚写入的摘要。");
    backend.store.set("scene_blocks/d.md", concurrent);

    await expect(
      writeSceneFileIfUnchanged("d.md", stale, "SHOULD NOT BE WRITTEN", {
        dataDir: "/unused",
        storage,
        logger: silentLogger,
      }),
    ).resolves.toBe(false);
    expect(backend.store.get("scene_blocks/d.md")).toBe(concurrent);
  });
});
