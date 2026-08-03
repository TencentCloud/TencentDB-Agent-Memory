/**
 * L1 message helpers: quality gate + new/background split + scene flattening.
 * Split from l1-extractor.ts.
 */
import { shouldExtractL1 } from "../../utils/sanitize.js";
import type { ConversationMessage } from "../conversation/l0-recorder.js";
import type { Logger } from "../types.js";
import type { ExtractedMemory, MemoryRecord, MemoryScope } from "./l1-writer.js";
import { generateMemoryId } from "./l1-writer.js";
import { normalizeType, type SceneSegment } from "./l1-extraction-types.js";

const TAG = "[memory-tdai][l1-extractor]";

export interface QualifiedSplit {
  newMessages: ConversationMessage[];
  backgroundMessages: ConversationMessage[];
  /** Count of messages that survived the L1 quality gate. */
  qualifiedCount: number;
}

/**
 * Filter messages through the L1 quality gate (shouldExtractL1) and split
 * into background (older) + new (recent) for the extraction call.
 * Returns null when nothing survives the gate.
 */
export function filterQualifiedMessages(
  messages: ConversationMessage[],
  maxNewMessages: number,
  maxBgMessages: number,
  logger?: Logger,
): QualifiedSplit | null {
  const qualifiedMessages = messages.filter((m) => shouldExtractL1(m.content));
  if (qualifiedMessages.length < messages.length) {
    logger?.debug?.(
      `${TAG} L1 quality filter: ${messages.length} → ${qualifiedMessages.length} messages ` +
      `(${messages.length - qualifiedMessages.length} filtered out)`,
    );
  }

  if (qualifiedMessages.length === 0) {
    return null;
  }

  // Split messages into background (older) + new (recent)
  const newMessages = qualifiedMessages.slice(-maxNewMessages);
  const bgEndIdx = qualifiedMessages.length - newMessages.length;
  const backgroundMessages = bgEndIdx > 0
    ? qualifiedMessages.slice(Math.max(0, bgEndIdx - maxBgMessages), bgEndIdx)
    : [];

  return { newMessages, backgroundMessages, qualifiedCount: qualifiedMessages.length };
}

export interface FlattenedScenes {
  sceneNames: string[];
  allExtracted: ExtractedMemory[];
}

/**
 * Assign temporary IDs + finalize scope for persistence (I3/I4):
 * only literal "global" without project id leaks; scope normalized to
 * what will actually be persisted so dedup filters correctly.
 */
export function prepareMemories(
  extracted: ExtractedMemory[],
  projectId: string | undefined,
  sessionKey: string,
  logger?: Logger,
): Array<ExtractedMemory & { record_id: string }> {
  const memoriesWithIds = extracted.map((m) => ({
    ...m,
    scope: (m.scope === "global" || !projectId ? "global" : "project") as MemoryScope,
    record_id: generateMemoryId(),
  }));

  if (!projectId && memoriesWithIds.some((m) => m.scope === "global")) {
    logger?.warn?.(`${TAG} No project_id for session ${sessionKey} — ${memoriesWithIds.length} memories stored as global (project_id plumbing broken upstream?)`);
  }

  return memoriesWithIds;
}

/**
 * Flatten all memories across scenes into a single list, dropping
 * memories with invalid types. Scene names collected for continuity.
 */
export function flattenScenes(scenes: SceneSegment[], logger?: Logger): FlattenedScenes {
  const allExtracted: ExtractedMemory[] = [];
  const sceneNames: string[] = [];

  for (const scene of scenes) {
    sceneNames.push(scene.scene_name);
    for (const mem of scene.memories) {
      const memType = normalizeType(mem.type);
      if (!memType) {
        logger?.warn?.(`${TAG} Skipping memory with invalid type "${mem.type}"`);
        continue;
      }
      allExtracted.push({
        content: mem.content,
        type: memType,
        priority: typeof mem.priority === "number" ? mem.priority : 50,
        source_message_ids: Array.isArray(mem.source_message_ids) ? mem.source_message_ids : [],
        metadata: mem.metadata ?? {},
        scene_name: scene.scene_name,
        scope: mem.scope === "global" ? "global" : "project",
      });
    }
  }

  return { sceneNames, allExtracted };
}
