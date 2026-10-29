/**
 * Explicit memory ingest (#417): mirrors host-native durable-memory writes
 * (e.g. Hermes built-in `memory(action="add", ...)`) directly into the L1
 * index — without pretending they were conversation turns.
 *
 * Unlike conversation-derived L1 extraction, explicit writes are already the
 * user's stated durable memory, so they skip L0/L1 classification and are
 * written straight to the searchable VectorStore (JSONL + vector).
 */

import type { EmbeddingService } from "../store/embedding.js";
import type { IMemoryStore } from "../store/types.js";
import type { Logger } from "../types.js";
import { generateMemoryId, writeMemory, type MemoryRecord, type MemoryType } from "./l1-writer.js";

const TAG = "[explicit-memory]";

export interface ExplicitMemoryIngestParams {
  action: string;
  target: string;
  content: string;
  baseDir: string;
  sessionKey: string;
  sessionId?: string;
  teamId?: string;
  userId?: string;
  agentId?: string;
  taskId?: string;
  logger?: Logger;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
}

/** Classify the Hermes memory target into an L1 type + scene name. */
function classifyTarget(target: string): { type: MemoryType; sceneName: string } {
  const normalized = target.trim().toLowerCase();

  if (normalized === "user" || normalized === "user.md" || normalized === "profile") {
    return { type: "persona", sceneName: "hermes_user_profile" };
  }

  return { type: "instruction", sceneName: "hermes_explicit_memory" };
}

/**
 * Ingest an explicit durable-memory write into L1.
 *
 * Returns the written MemoryRecord, or null when the write was rejected
 * (non-"add" action, empty content, or VectorStore write not available).
 *
 * The VectorStore write is required (`requireVectorStoreWrite: true`) so the
 * memory is actually retrievable via memory search — a JSONL-only write would
 * silently satisfy the write but never surface in recall.
 */
export async function ingestExplicitMemory(params: ExplicitMemoryIngestParams): Promise<MemoryRecord | null> {
  const action = params.action.trim().toLowerCase();
  if (action !== "add") return null;

  const content = params.content.trim();
  if (!content) return null;

  const { type, sceneName } = classifyTarget(params.target);

  try {
    return await writeMemory({
      memory: {
        content,
        type,
        priority: 90,
        source_message_ids: [],
        metadata: {},
        scene_name: sceneName,
      },
      decision: {
        record_id: generateMemoryId(),
        action: "store",
        target_ids: [],
      },
      baseDir: params.baseDir,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      teamId: params.teamId,
      userId: params.userId,
      agentId: params.agentId,
      taskId: params.taskId,
      logger: params.logger,
      vectorStore: params.vectorStore,
      embeddingService: params.embeddingService,
      requireVectorStoreWrite: true,
    });
  } catch (err) {
    params.logger?.warn?.(
      `${TAG} explicit memory write rejected: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
