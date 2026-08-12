/**
 * tz-10a Ф0 — характеризация того, что теряется между стором и recall.
 *
 * Пакет tz-10a требует item-level данных (C10.3) и диагностики вместо
 * молчаливой пустоты (C10.5). Этот файл фиксирует ДО правки, что именно
 * ломается сегодня, чтобы «стало лучше» доказывалось изменением снимка,
 * а не формулировкой:
 *
 *   1. `searchMemoriesWithDetails` восстанавливает элементы regex'ом из уже
 *      отрендеренной строки — score у всех 0, id записи отсутствует;
 *   2. падение стора неотличимо от «памяти нет»: пустой результат без следа.
 *
 * После Ф1–Ф3 ожидания в этом файле обновляются на структурные (score.final,
 * memoryId, diagnostics) — снимок и есть доказательство перехода.
 */
import { describe, it, expect } from "vitest";
import { parseConfig, type MemoryTdaiConfig } from "../../../config.js";
import { searchMemoriesWithDetails } from "./scope.js";
import type { IMemoryStore, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function cfg(): MemoryTdaiConfig {
  return parseConfig({
    recall: { strategy: "embedding", scoreThreshold: 0.1, maxResults: 3 },
  });
}

const candidate = (id: string, score: number): L1SearchResult => ({
  record_id: id,
  content: `content of ${id}`,
  type: "episodic",
  priority: 50,
  scene_name: "",
  score,
  timestamp_str: "",
  timestamp_start: "",
  timestamp_end: "",
  session_key: "s",
  session_id: "s",
  metadata_json: "{}",
});

function storeOf(results: L1SearchResult[]): IMemoryStore {
  return {
    searchL1Vector: async () => results,
    isFtsAvailable: () => false,
    getCapabilities: () => ({ nativeHybridSearch: false }),
  } as unknown as IMemoryStore;
}

function throwingStore(): IMemoryStore {
  return {
    searchL1Vector: async () => {
      throw new Error("sqlite: database is locked");
    },
    isFtsAvailable: () => false,
    getCapabilities: () => ({ nativeHybridSearch: false }),
  } as unknown as IMemoryStore;
}

const fakeEmbedding: EmbeddingService = {
  embed: async () => new Float32Array(4),
} as unknown as EmbeddingService;

describe("tz-10a characterization: what the recall path loses", () => {
  it("returns items with the store's real score and record id", async () => {
    const r = await searchMemoriesWithDetails(
      "query",
      "/tmp",
      cfg(),
      silentLogger,
      "embedding",
      storeOf([candidate("rec-a", 0.9), candidate("rec-b", 0.7)]),
      fakeEmbedding,
    );

    expect(r.memories).toHaveLength(2);
    // Was 0 for every element before tz-10a (regex re-parse of the rendered line).
    expect(r.memories[0]!.score).toBeCloseTo(0.9, 6);
    expect(r.memories[1]!.score).toBeCloseTo(0.7, 6);
    // The record id never survived the string round-trip at all.
    expect(r.items.map((i) => i.memoryId)).toEqual(["rec-a", "rec-b"]);
    expect(r.items[0]!.score.raw).toBeCloseTo(0.9, 6);
  });

  it("a failing store is reported as a diagnostic, not as an empty memory", async () => {
    const r = await searchMemoriesWithDetails(
      "query",
      "/tmp",
      cfg(),
      silentLogger,
      "embedding",
      throwingStore(),
      fakeEmbedding,
    );

    expect(r.lines).toEqual([]);
    // Before tz-10a the caller saw exactly the same thing as "nothing matched".
    expect(r.diagnostics.map((d) => `${d.stage}:${d.code}`)).toContain(
      "repo:search-failed",
    );
    expect(r.diagnostics[0]!.message).toContain("database is locked");
  });
});
