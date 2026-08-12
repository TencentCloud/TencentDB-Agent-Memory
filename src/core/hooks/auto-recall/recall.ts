/** `performAutoRecall` orchestrator: search L1 + load persona + load scene nav. */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CONTEXT_BUDGET_TOKENS, type MemoryTdaiConfig } from "../../../config.js";
import { readSceneIndex } from "../../scene/scene-index.js";
import { generateSceneNavigation, stripSceneNavigation } from "../../scene/scene-navigation.js";
import type { EmbeddingService } from "../../store/embedding.js";
import type { IMemoryStore } from "../../store/types.js";
import type { Logger } from "../../types.js";
import { MEMORY_TOOLS_GUIDE, RECALL_ITEM_SCHEMA_VERSION, RECALL_LINE_SEPARATOR, TAG, type RecallDiagnostic, type RecallResult, type RecalledMemory, type SearchTiming } from "./types.js";
import { searchMemories } from "./search.js";
import { itemToRecalledMemory } from "./scope.js";
import { applyRecallBudget, type RenderedItem } from "./budget.js";
import { assembleContext, DEFAULT_PRECEDENCE } from "../../context/assemble.js";
import { createCharTokenizer } from "../../context/tokenizer.js";
import type { ContextEnvelope, ContextSegment, MemoryItem } from "../../context/types.js";

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
  const { cfg, pluginDataDir, logger } = params;
  const projectId = params.projectId ?? "";
  const tRecallStart = performance.now();

  const l1 = await recallL1(params);
  const persona = await loadPersona(pluginDataDir, cfg, params.includePersona ?? true, logger);
  const scene = await loadSceneNavigation(pluginDataDir, projectId, logger);
  logRecallTiming(logger, { totalMs: performance.now() - tRecallStart, l1, persona, scene });

  if (l1.memoryLines.length === 0 && !persona.content && !scene.content) {
    logger?.debug?.(`${TAG} No memories/persona/scenes to inject`);
    // Nothing to inject, but WHY there is nothing must survive: a broken store
    // and an empty memory are different answers (tz-10 C10.5). No context field
    // is set, so no caller injects anything either way.
    if (l1.diagnostics.length === 0) return undefined;
    return { recalledL1Memories: [], recallStrategy: l1.strategy, diagnostics: l1.diagnostics };
  }
  return projectContext({ l1, persona: persona.content, scene: scene.content, projectId, sessionKey: params.sessionKey, cfg });
}

/** What the L1 search leg produced, with the numbers the timing line reports. */
interface L1Recall {
  kept: RenderedItem[]; memoryLines: string[]; recalledL1Memories: RecalledMemory[];
  diagnostics: RecallDiagnostic[]; strategy: string; timing: SearchTiming; ms: number;
}

/** Search L1 and cut it to the per-recall budget. Empty input = a skipped leg, not a failure. */
async function recallL1(params: {
  userText: string; cfg: MemoryTdaiConfig; pluginDataDir: string;
  logger?: Logger; vectorStore?: IMemoryStore; embeddingService?: EmbeddingService; projectId?: string;
}): Promise<L1Recall> {
  const { userText, cfg, pluginDataDir, logger, vectorStore, embeddingService } = params;
  const started = performance.now();
  const empty: L1Recall = {
    kept: [], memoryLines: [], recalledL1Memories: [], diagnostics: [], strategy: "skipped",
    timing: { ftsMs: 0, embeddingMs: 0, ftsHits: 0, embeddingHits: 0 }, ms: 0,
  };
  if (!userText || userText.length === 0) {
    logger?.debug?.(`${TAG} User text empty/undefined, skipping memory search (persona/scene still injected)`);
    return { ...empty, ms: performance.now() - started };
  }
  const strategy = cfg.recall.strategy ?? "hybrid";
  const searchResult = await searchMemories(userText, pluginDataDir, cfg, logger, strategy as "keyword" | "embedding" | "hybrid", vectorStore, embeddingService, params.projectId ?? "");
  // Items and their lines travel together through the budget, so a reported
  // memory keeps the id and the real score the store gave it — before tz-10a
  // they were regex-parsed back out of the rendered line with score 0 (C10.3).
  const budget = applyRecallBudget(
    searchResult.items.map((item, i) => ({ item, line: searchResult.lines[i]! })),
    cfg.recall,
    logger,
  );
  const diagnostics = [...searchResult.diagnostics, ...budget.diagnostics];
  if (diagnostics.length > 0) {
    logger?.debug?.(`${TAG} Recall diagnostics: ${diagnostics.map((d) => `${d.stage}:${d.code}`).join(", ")}`);
  }
  // A failing store is not an empty memory: say so where a human looks.
  for (const d of diagnostics.filter((x) => x.stage === "repo")) {
    logger?.warn?.(`${TAG} ⚠️ ${d.code}: ${d.message}`);
  }
  return {
    kept: budget.kept, memoryLines: budget.kept.map((r) => r.line),
    recalledL1Memories: budget.kept.map((r) => itemToRecalledMemory(r.item)),
    diagnostics, strategy, timing: searchResult.timing, ms: performance.now() - started,
  };
}

/** L3 persona from disk, truncated to the configured char cap. Missing file = no persona. */
async function loadPersona(pluginDataDir: string, cfg: MemoryTdaiConfig, includePersona: boolean, logger?: Logger): Promise<{ content?: string; ms: number }> {
  const started = performance.now();
  let content: string | undefined;
  try {
    if (!includePersona) throw new Error("persona injection skipped this turn");
    const raw = await fs.readFile(path.join(pluginDataDir, "persona.md"), "utf-8");
    content = stripSceneNavigation(raw).trim() || undefined;
    const maxPersonaChars = normalizeMaxChars(cfg.recall.maxPersonaChars);
    if (content && maxPersonaChars && [...content].length > maxPersonaChars) {
      const kept = [...content].slice(0, maxPersonaChars).join("");
      logger?.info(`${TAG} Persona truncated: ${content.length} → ${kept.length} chars (recall.maxPersonaChars=${maxPersonaChars})`);
      content = `${kept}\n…(persona truncated)`;
    }
    logger?.debug?.(`${TAG} Persona loaded: ${content ? `${content.length} chars` : "empty"}`);
  } catch {
    logger?.debug?.(includePersona ? `${TAG} No persona file found (expected for new users)` : `${TAG} Persona skipped this turn (client cadence gate)`);
  }
  return { content, ms: performance.now() - started };
}

/** L2 scene navigation for this project. No index = no navigation, not an error. */
async function loadSceneNavigation(pluginDataDir: string, projectId: string, logger?: Logger): Promise<{ content?: string; ms: number }> {
  const started = performance.now();
  let content: string | undefined;
  try {
    const sceneIndex = await readSceneIndex(pluginDataDir, projectId);
    if (sceneIndex.length > 0) {
      content = generateSceneNavigation(sceneIndex, pluginDataDir, projectId);
      logger?.debug?.(`${TAG} Scene navigation generated: ${sceneIndex.length} scenes (project=${projectId || "(none)"})`);
    }
  } catch { logger?.debug?.(`${TAG} No scene index found`); }
  return { content, ms: performance.now() - started };
}

/** One line per recall, logged whether or not anything was found. */
function logRecallTiming(logger: Logger | undefined, r: { totalMs: number; l1: L1Recall; persona: { content?: string; ms: number }; scene: { content?: string; ms: number } }): void {
  logger?.info(
    `${TAG} ⏱ Recall timing: total=${r.totalMs.toFixed(0)}ms, ` +
    `search=${r.l1.ms.toFixed(0)}ms(strategy=${r.l1.strategy},hits=${r.l1.memoryLines.length},` +
    `fts=${r.l1.timing.ftsMs.toFixed(0)}ms/${r.l1.timing.ftsHits}hits,` +
    `vec=${r.l1.timing.embeddingMs.toFixed(0)}ms/${r.l1.timing.embeddingHits}hits), ` +
    `persona=${r.persona.ms.toFixed(0)}ms(${r.persona.content ? `${r.persona.content.length}chars` : "none"}), ` +
    `scene=${r.scene.ms.toFixed(0)}ms(${r.scene.content ? "loaded" : "none"})`,
  );
}

/**
 * One assembly decides what fits, in tokens, across memories AND persona AND
 * scene navigation (tz-10b). The returned fields are a projection of the
 * envelope — nothing is parsed back out of the rendered string (C10.2).
 */
function projectContext(p: {
  l1: L1Recall; persona?: string; scene?: string; projectId: string; sessionKey: string; cfg: MemoryTdaiConfig;
}): RecallResult | undefined {
  const { items, lineById } = buildContextItems(p.l1.kept, p.persona, p.scene, p.projectId);
  const envelope = assembleContext({
    items,
    policy: { precedence: DEFAULT_PRECEDENCE, dedup: "exact" },
    budget: {
      // A hand-built config (tests, embedders) may not carry the knob; falling
      // back keeps the context injected instead of silently empty.
      total: positiveOr(p.cfg.recall.contextBudgetTokens, DEFAULT_CONTEXT_BUDGET_TOKENS),
      reservedForUser: positiveOr(p.cfg.recall.reservedForUserTokens, 0),
    },
    tokenizer: createCharTokenizer(),
    render: (included) => renderSegments(included, lineById),
    // The recall entry point carries no session id today; the envelope says so
    // instead of inventing one.
    request: { requestId: randomUUID(), sessionKey: p.sessionKey, sessionId: "", projectId: p.projectId },
  });
  const slot = (which: ContextSegment["slot"]): string | undefined => {
    const text = envelope.segments.filter((s) => s.slot === which).map((s) => s.text).join("\n\n");
    return text.length > 0 ? text : undefined;
  };
  const prependContext = slot("prepend");
  const appendSystemContext = slot("append");
  if (!appendSystemContext && !prependContext) return undefined;
  const includedIds = new Set(envelope.included.map((i) => i.memoryId));
  return {
    prependContext, appendSystemContext,
    // Aligned by position: `items` keeps the L1 elements in the order they were
    // recalled, so index i of one is index i of the other.
    recalledL1Memories: p.l1.recalledL1Memories.filter((_, i) => includedIds.has(items[i]?.memoryId ?? "")),
    recalledL3Persona: envelope.included.some((i) => i.kind === "persona") ? (p.persona ?? null) : null,
    recallStrategy: p.l1.strategy,
    diagnostics: [...p.l1.diagnostics, ...envelope.diagnostics],
    envelope,
  };
}

/**
 * Everything that can enter the context, plus the line each L1 item renders as.
 *
 * The keys are made unique here on purpose: a backend may expose no record id
 * (TCVDB returns ""), and keying the lines by `memoryId` would then collapse
 * two different memories into one. `recalledL1Memories` is aligned by position,
 * so L1 items keep their input order in `items`.
 */
function buildContextItems(
  kept: RenderedItem[],
  personaContent: string | undefined,
  sceneNavigation: string | undefined,
  projectId: string,
): { items: MemoryItem[]; lineById: Map<string, string> } {
  const lineById = new Map<string, string>();
  const items: MemoryItem[] = kept.map((rendered, index) => {
    const base = rendered.item.memoryId || `l1-${index}`;
    const memoryId = lineById.has(base) ? `${base}#${index}` : base;
    lineById.set(memoryId, rendered.line);
    return { ...rendered.item, memoryId, kind: "l1", tokenCost: 0 };
  });
  if (personaContent) items.push(personaItem(personaContent));
  if (sceneNavigation) items.push(sceneItem(sceneNavigation, projectId));
  return { items, lineById };
}

/** The injected blocks, in the order the HTTP response concatenates them. */
function renderSegments(included: MemoryItem[], lineById: Map<string, string>): ContextSegment[] {
  const segments: ContextSegment[] = [];
  const memories = included.filter((i) => i.kind === "l1");
  if (memories.length > 0) {
    const lines = memories.map((i) => lineById.get(i.memoryId) ?? i.content);
    segments.push({
      slot: "prepend",
      itemIds: memories.map((i) => i.memoryId),
      text: `<relevant-memories>\n以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：\n\n${lines.join(RECALL_LINE_SEPARATOR)}\n</relevant-memories>`,
    });
  }
  const persona = included.find((i) => i.kind === "persona");
  if (persona) {
    segments.push({ slot: "append", itemIds: [persona.memoryId], text: `<user-persona>\n${persona.content}\n</user-persona>` });
  }
  const scene = included.find((i) => i.kind === "scene");
  if (scene) {
    segments.push({ slot: "append", itemIds: [scene.memoryId], text: `<scene-navigation>\n${scene.content}\n</scene-navigation>` });
  }
  // The tools guide belongs to no memory: it is prompt scaffolding, it rides
  // along only when something was included, and its cost is render overhead.
  if (segments.length > 0) segments.push({ slot: "append", itemIds: [], text: MEMORY_TOOLS_GUIDE });
  return segments;
}

/** Persona as an item: identity from its content, so an edited persona is a new id. */
function personaItem(content: string): MemoryItem {
  return contextItem(`persona:${createHash("sha1").update(content).digest("hex").slice(0, 8)}`, "persona", content);
}

/** Scene navigation as an item — one per project (or the global tree). */
function sceneItem(content: string, projectId: string): MemoryItem {
  return contextItem(`scene-nav:${projectId || "global"}`, "scene", content);
}

/**
 * Shared shape for the two elements search does not produce. Provenance stays
 * "unknown" until tz-05 gives these files a real owner (C10.7) — it is not
 * quietly filled in with "global".
 */
function contextItem(memoryId: string, kind: "persona" | "scene", content: string): MemoryItem {
  return {
    schemaVersion: RECALL_ITEM_SCHEMA_VERSION,
    memoryId,
    kind,
    content,
    formatable: { type: kind === "persona" ? "persona" : "scene-nav", content },
    scope: { userId: null },
    provenance: { sourceIds: [], producer: kind, createdAt: "", updatedAt: "", status: "unknown" },
    score: { raw: 1, final: 1, reasons: [kind] },
    tokenCost: 0,
  };
}

/** A finite non-negative number, or the fallback. */
function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeMaxChars(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}
