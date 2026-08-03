/** `performAutoRecall` orchestrator: search L1 + load persona + load scene nav. */

import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryTdaiConfig } from "../../../config.js";
import { readSceneIndex } from "../../scene/scene-index.js";
import { generateSceneNavigation, stripSceneNavigation } from "../../scene/scene-navigation.js";
import type { EmbeddingService } from "../../store/embedding.js";
import type { IMemoryStore } from "../../store/types.js";
import type { Logger } from "../../types.js";
import { MEMORY_TOOLS_GUIDE, RECALL_LINE_SEPARATOR, TAG, type RecallResult, type RecalledMemory, type SearchTiming } from "./types.js";
import { searchMemories } from "./search.js";
import { applyRecallBudget } from "./budget.js";

export async function performAutoRecall(params: {
  userText: string; actorId: string; sessionKey: string;
  cfg: MemoryTdaiConfig; pluginDataDir: string;
  logger?: Logger; vectorStore?: IMemoryStore; embeddingService?: EmbeddingService;
  projectId?: string; includePersona?: boolean;
}): Promise<RecallResult | undefined> {
  const { cfg, logger } = params;
  const timeoutMs = cfg.recall.timeoutMs ?? 5000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    performAutoRecallInner(params).finally(() => { if (timer) clearTimeout(timer); }),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        logger?.warn?.(`${TAG} ⚠️ Recall timed out after ${timeoutMs}ms — skipping memory injection to avoid blocking the user`);
        resolve(undefined);
      }, timeoutMs);
    }),
  ]);
}

async function performAutoRecallInner(params: {
  userText: string; actorId: string; sessionKey: string;
  cfg: MemoryTdaiConfig; pluginDataDir: string;
  logger?: Logger; vectorStore?: IMemoryStore; embeddingService?: EmbeddingService;
  projectId?: string; includePersona?: boolean;
}): Promise<RecallResult | undefined> {
  const { userText, cfg, pluginDataDir, logger, vectorStore, embeddingService } = params;
  const includePersona = params.includePersona ?? true;
  const projectId = params.projectId ?? "";
  const tRecallStart = performance.now();

  // L1 search
  const tSearchStart = performance.now();
  let memoryLines: string[] = [];
  let effectiveStrategy = "skipped";
  let recalledL1Memories: RecalledMemory[] = [];
  let searchTiming: SearchTiming = { ftsMs: 0, embeddingMs: 0, ftsHits: 0, embeddingHits: 0 };
  if (!userText || userText.length === 0) {
    logger?.debug?.(`${TAG} User text empty/undefined, skipping memory search (persona/scene still injected)`);
  } else {
    effectiveStrategy = cfg.recall.strategy ?? "hybrid";
    const searchResult = await searchMemories(userText, pluginDataDir, cfg, logger, effectiveStrategy as "keyword" | "embedding" | "hybrid", vectorStore, embeddingService, projectId);
    memoryLines = searchResult.lines;
    searchTiming = searchResult.timing;
    memoryLines = applyRecallBudget(memoryLines, cfg.recall, logger);
    recalledL1Memories = memoryLines.map((line) => {
      const match = line.match(/^-\s+\[([^\]]+)\]\s+(.+?)(?:\s*\(活动时间:.*\))?$/);
      if (match) {
        const tag = match[1]!; const content = match[2]!.trim();
        const typePart = tag.includes("|") ? tag.split("|")[0] : tag;
        return { content, score: 0, type: typePart };
      }
      return { content: line, score: 0, type: "unknown" };
    });
  }
  const tSearchEnd = performance.now();

  // L3 persona
  const tPersonaStart = performance.now();
  let personaContent: string | undefined;
  try {
    if (!includePersona) throw new Error("persona injection skipped this turn");
    const personaPath = path.join(pluginDataDir, "persona.md");
    const raw = await fs.readFile(personaPath, "utf-8");
    personaContent = stripSceneNavigation(raw).trim();
    if (!personaContent) personaContent = undefined;
    const maxPersonaChars = normalizeMaxChars(cfg.recall.maxPersonaChars);
    if (personaContent && maxPersonaChars && [...personaContent].length > maxPersonaChars) {
      const kept = [...personaContent].slice(0, maxPersonaChars).join("");
      logger?.info(`${TAG} Persona truncated: ${personaContent.length} → ${kept.length} chars (recall.maxPersonaChars=${maxPersonaChars})`);
      personaContent = `${kept}\n…(persona truncated)`;
    }
    logger?.debug?.(`${TAG} Persona loaded: ${personaContent ? `${personaContent.length} chars` : "empty"}`);
  } catch {
    logger?.debug?.(includePersona ? `${TAG} No persona file found (expected for new users)` : `${TAG} Persona skipped this turn (client cadence gate)`);
  }
  const tPersonaEnd = performance.now();

  // L2 scene nav
  const tSceneStart = performance.now();
  let sceneNavigation: string | undefined;
  try {
    const sceneIndex = await readSceneIndex(pluginDataDir, projectId);
    if (sceneIndex.length > 0) {
      sceneNavigation = generateSceneNavigation(sceneIndex, pluginDataDir, projectId);
      logger?.debug?.(`${TAG} Scene navigation generated: ${sceneIndex.length} scenes (project=${projectId || "(none)"})`);
    }
  } catch { logger?.debug?.(`${TAG} No scene index found`); }
  const tSceneEnd = performance.now();

  // Log timing (success or empty)
  const totalMs = performance.now() - tRecallStart;
  const personaStr = personaContent ? `${personaContent.length}chars` : "none";
  const sceneStr = sceneNavigation ? "loaded" : "none";
  logger?.info(
    `${TAG} ⏱ Recall timing: total=${totalMs.toFixed(0)}ms, ` +
    `search=${(tSearchEnd - tSearchStart).toFixed(0)}ms(strategy=${effectiveStrategy},hits=${memoryLines.length},` +
    `fts=${searchTiming.ftsMs.toFixed(0)}ms/${searchTiming.ftsHits}hits,` +
    `vec=${searchTiming.embeddingMs.toFixed(0)}ms/${searchTiming.embeddingHits}hits), ` +
    `persona=${(tPersonaEnd - tPersonaStart).toFixed(0)}ms(${personaStr}), ` +
    `scene=${(tSceneEnd - tSceneStart).toFixed(0)}ms(${sceneStr})`,
  );

  if (memoryLines.length === 0 && !personaContent && !sceneNavigation) {
    logger?.debug?.(`${TAG} No memories/persona/scenes to inject`);
    return undefined;
  }

  // Split into stable (system) and dynamic (user) parts to optimize prompt caching.
  const stableParts: string[] = [];
  if (personaContent) stableParts.push(`<user-persona>\n${personaContent}\n</user-persona>`);
  if (sceneNavigation) stableParts.push(`<scene-navigation>\n${sceneNavigation}\n</scene-navigation>`);
  let prependContext: string | undefined;
  if (memoryLines.length > 0) {
    prependContext = `<relevant-memories>\n以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：\n\n${memoryLines.join(RECALL_LINE_SEPARATOR)}\n</relevant-memories>`;
  }
  if (stableParts.length > 0 || prependContext) stableParts.push(MEMORY_TOOLS_GUIDE);
  const appendSystemContext = stableParts.length > 0 ? stableParts.join("\n\n") : undefined;
  if (!appendSystemContext && !prependContext) return undefined;

  return {
    prependContext, appendSystemContext, recalledL1Memories,
    recalledL3Persona: personaContent ?? null, recallStrategy: effectiveStrategy,
  };
}

function normalizeMaxChars(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}
