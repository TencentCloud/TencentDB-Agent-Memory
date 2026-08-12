/** `performAutoRecall` orchestrator: search L1 + load persona + load scene nav. */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  type MemoryTdaiConfig,
} from "../../../config.js";
import { readSceneIndex } from "../../scene/scene-index.js";
import {
  generateSceneNavigation,
  stripSceneNavigation,
} from "../../scene/scene-navigation.js";
import type { EmbeddingService } from "../../store/embedding.js";
import type { IMemoryStore } from "../../store/types.js";
import type { Logger } from "../../types.js";
import {
  MEMORY_TOOLS_GUIDE,
  RECALL_ITEM_SCHEMA_VERSION,
  RECALL_LINE_SEPARATOR,
  TAG,
  type RecallDiagnostic,
  type RecallItem,
  type RecallResult,
  type RecalledMemory,
  type SearchTiming,
} from "./types.js";
import { searchMemories } from "./search.js";
import { itemToRecalledMemory } from "./scope.js";
import { applyRecallBudget } from "./budget.js";
import { assembleContext, DEFAULT_PRECEDENCE } from "../../context/assemble.js";
import { createCharTokenizer } from "../../context/tokenizer.js";
import type { ContextSegment, MemoryItem } from "../../context/types.js";

export async function performAutoRecall(params: {
  userText: string;
  actorId: string;
  sessionKey: string;
  cfg: MemoryTdaiConfig;
  pluginDataDir: string;
  logger?: Logger;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  projectId?: string;
  includePersona?: boolean;
}): Promise<RecallResult | undefined> {
  const { cfg, logger } = params;
  const timeoutMs = cfg.recall.timeoutMs ?? 5000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    performAutoRecallInner(params).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        logger?.warn?.(
          `${TAG} ⚠️ Recall timed out after ${timeoutMs}ms — skipping memory injection to avoid blocking the user`,
        );
        resolve(undefined);
      }, timeoutMs);
    }),
  ]);
}

async function performAutoRecallInner(params: {
  userText: string;
  actorId: string;
  sessionKey: string;
  cfg: MemoryTdaiConfig;
  pluginDataDir: string;
  logger?: Logger;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  projectId?: string;
  includePersona?: boolean;
}): Promise<RecallResult | undefined> {
  const {
    userText,
    cfg,
    pluginDataDir,
    logger,
    vectorStore,
    embeddingService,
  } = params;
  const includePersona = params.includePersona ?? true;
  const projectId = params.projectId ?? "";
  const tRecallStart = performance.now();

  // L1 search
  const tSearchStart = performance.now();
  let memoryLines: string[] = [];
  let effectiveStrategy = "skipped";
  let recalledL1Memories: RecalledMemory[] = [];
  let keptItems: Array<{ item: RecallItem; line: string }> = [];
  let recallDiagnostics: RecallDiagnostic[] = [];
  let searchTiming: SearchTiming = {
    ftsMs: 0,
    embeddingMs: 0,
    ftsHits: 0,
    embeddingHits: 0,
  };
  if (!userText || userText.length === 0) {
    logger?.debug?.(
      `${TAG} User text empty/undefined, skipping memory search (persona/scene still injected)`,
    );
  } else {
    effectiveStrategy = cfg.recall.strategy ?? "hybrid";
    const searchResult = await searchMemories(
      userText,
      pluginDataDir,
      cfg,
      logger,
      effectiveStrategy as "keyword" | "embedding" | "hybrid",
      vectorStore,
      embeddingService,
      projectId,
    );
    searchTiming = searchResult.timing;
    // Items and their lines travel together through the budget, so a reported
    // memory keeps the id and the real score the store gave it — before tz-10a
    // they were regex-parsed back out of the rendered line with score 0 (C10.3).
    const budget = applyRecallBudget(
      searchResult.items.map((item, i) => ({
        item,
        line: searchResult.lines[i]!,
      })),
      cfg.recall,
      logger,
    );
    keptItems = budget.kept;
    memoryLines = budget.kept.map((r) => r.line);
    recalledL1Memories = budget.kept.map((r) => itemToRecalledMemory(r.item));
    recallDiagnostics = [...searchResult.diagnostics, ...budget.diagnostics];
    if (recallDiagnostics.length > 0) {
      logger?.debug?.(
        `${TAG} Recall diagnostics: ${recallDiagnostics.map((d) => `${d.stage}:${d.code}`).join(", ")}`,
      );
    }
    // A failing store is not an empty memory: say so where a human looks.
    for (const d of recallDiagnostics.filter((x) => x.stage === "repo")) {
      logger?.warn?.(`${TAG} ⚠️ ${d.code}: ${d.message}`);
    }
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
    if (
      personaContent &&
      maxPersonaChars &&
      [...personaContent].length > maxPersonaChars
    ) {
      const kept = [...personaContent].slice(0, maxPersonaChars).join("");
      logger?.info(
        `${TAG} Persona truncated: ${personaContent.length} → ${kept.length} chars (recall.maxPersonaChars=${maxPersonaChars})`,
      );
      personaContent = `${kept}\n…(persona truncated)`;
    }
    logger?.debug?.(
      `${TAG} Persona loaded: ${personaContent ? `${personaContent.length} chars` : "empty"}`,
    );
  } catch {
    logger?.debug?.(
      includePersona
        ? `${TAG} No persona file found (expected for new users)`
        : `${TAG} Persona skipped this turn (client cadence gate)`,
    );
  }
  const tPersonaEnd = performance.now();

  // L2 scene nav
  const tSceneStart = performance.now();
  let sceneNavigation: string | undefined;
  try {
    const sceneIndex = await readSceneIndex(pluginDataDir, projectId);
    if (sceneIndex.length > 0) {
      sceneNavigation = generateSceneNavigation(
        sceneIndex,
        pluginDataDir,
        projectId,
      );
      logger?.debug?.(
        `${TAG} Scene navigation generated: ${sceneIndex.length} scenes (project=${projectId || "(none)"})`,
      );
    }
  } catch {
    logger?.debug?.(`${TAG} No scene index found`);
  }
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
    // Nothing to inject, but WHY there is nothing must survive: a broken store
    // and an empty memory are different answers (tz-10 C10.5). No context field
    // is set, so no caller injects anything either way.
    if (recallDiagnostics.length === 0) return undefined;
    return {
      recalledL1Memories: [],
      recallStrategy: effectiveStrategy,
      diagnostics: recallDiagnostics,
    };
  }

  // One assembly decides what fits (tz-10b). The text below is a projection of
  // the envelope, never the other way round: nothing is parsed back out of it.
  const lineById = new Map(keptItems.map((r) => [r.item.memoryId, r.line]));
  const render = (included: MemoryItem[]): ContextSegment[] => {
    const segments: ContextSegment[] = [];
    const memories = included.filter((i) => i.kind === "l1");
    if (memories.length > 0) {
      segments.push({
        slot: "prepend",
        itemIds: memories.map((i) => i.memoryId),
        text: `<relevant-memories>\n以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：\n\n${memories
          .map((i) => lineById.get(i.memoryId) ?? i.content)
          .join(RECALL_LINE_SEPARATOR)}\n</relevant-memories>`,
      });
    }
    const persona = included.find((i) => i.kind === "persona");
    if (persona) {
      segments.push({
        slot: "append",
        itemIds: [persona.memoryId],
        text: `<user-persona>\n${persona.content}\n</user-persona>`,
      });
    }
    const scene = included.find((i) => i.kind === "scene");
    if (scene) {
      segments.push({
        slot: "append",
        itemIds: [scene.memoryId],
        text: `<scene-navigation>\n${scene.content}\n</scene-navigation>`,
      });
    }
    // The tools guide belongs to no memory: it is prompt scaffolding, it rides
    // along only when something was included, and its cost is render overhead.
    if (segments.length > 0) {
      segments.push({ slot: "append", itemIds: [], text: MEMORY_TOOLS_GUIDE });
    }
    return segments;
  };

  const envelope = assembleContext({
    items: [
      ...keptItems.map((r): MemoryItem => ({
        ...r.item,
        kind: "l1",
        tokenCost: 0,
      })),
      ...(personaContent ? [personaItem(personaContent)] : []),
      ...(sceneNavigation ? [sceneItem(sceneNavigation, projectId)] : []),
    ],
    policy: {
      precedence: DEFAULT_PRECEDENCE,
      reservedForUser: positiveOr(cfg.recall.reservedForUserTokens, 0),
      dedup: "exact",
    },
    budget: {
      // A config assembled by hand (tests, embedders) may not carry the knob;
      // falling back keeps the context injected instead of silently empty.
      total: positiveOr(
        cfg.recall.contextBudgetTokens,
        DEFAULT_CONTEXT_BUDGET_TOKENS,
      ),
      reservedForUser: positiveOr(cfg.recall.reservedForUserTokens, 0),
    },
    tokenizer: createCharTokenizer(),
    render,
    // The recall entry point carries no session id today; the envelope says so
    // rather than inventing one.
    request: {
      requestId: randomUUID(),
      sessionKey: params.sessionKey,
      sessionId: "",
      projectId,
    },
  });
  recallDiagnostics = [...recallDiagnostics, ...envelope.diagnostics];

  // Re-rendering the included items is deterministic and gives the two fields
  // the caller already knows; splitting `renderedContext` back would be the
  // reverse parse tz-10 C10.2 forbids.
  const segments = render(envelope.included);
  const join = (slot: ContextSegment["slot"]): string | undefined => {
    const text = segments
      .filter((s) => s.slot === slot)
      .map((s) => s.text)
      .join("\n\n");
    return text.length > 0 ? text : undefined;
  };
  const prependContext = join("prepend");
  const appendSystemContext = join("append");
  if (!appendSystemContext && !prependContext) return undefined;

  const includedIds = new Set(envelope.included.map((i) => i.memoryId));
  return {
    prependContext,
    appendSystemContext,
    recalledL1Memories: recalledL1Memories.filter((_, i) =>
      includedIds.has(keptItems[i]!.item.memoryId),
    ),
    recalledL3Persona: envelope.included.some((i) => i.kind === "persona")
      ? (personaContent ?? null)
      : null,
    recallStrategy: effectiveStrategy,
    diagnostics: recallDiagnostics,
    envelope,
  };
}

/** A finite non-negative number, or the fallback. */
function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

/** Persona as an item: identity from its content, so a changed persona is a new id. */
function personaItem(content: string): MemoryItem {
  return contextItem(
    `persona:${createHash("sha1").update(content).digest("hex").slice(0, 8)}`,
    "persona",
    content,
  );
}

/** Scene navigation as an item — one per project (or the global tree). */
function sceneItem(content: string, projectId: string): MemoryItem {
  return contextItem(`scene-nav:${projectId || "global"}`, "scene", content);
}

/**
 * Shared shape for the two non-search elements. Provenance stays "unknown"
 * until tz-05 gives these files a real owner (C10.7) — it is not faked global.
 */
function contextItem(
  memoryId: string,
  kind: "persona" | "scene",
  content: string,
): MemoryItem {
  return {
    schemaVersion: RECALL_ITEM_SCHEMA_VERSION,
    memoryId,
    kind,
    content,
    formatable: { type: kind === "persona" ? "persona" : "scene-nav", content },
    scope: { userId: null },
    provenance: {
      sourceIds: [],
      producer: kind,
      createdAt: "",
      updatedAt: "",
      status: "unknown",
    },
    score: { raw: 1, final: 1, reasons: [kind] },
    tokenCost: 0,
  };
}

function normalizeMaxChars(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}
