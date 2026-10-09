/**
 * Explicit memory ingest: mirrors host-native durable-memory writes directly
 * into L1 without pretending they were conversation turns.
 */

import type { EmbeddingService } from "../store/embedding.js";
import type { IMemoryStore } from "../store/types.js";
import type { Logger } from "../types.js";
import { generateMemoryId, writeMemory, type MemoryRecord, type MemoryType } from "./l1-writer.js";

export interface ExplicitMemoryIngestParams {
  action: string;
  target: string;
  content: string;
  baseDir: string;
  sessionKey: string;
  sessionId?: string;
  logger?: Logger;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
}

function classifyTarget(target: string): { type: MemoryType; sceneName: string } {
  const normalized = target.trim().toLowerCase();

  if (normalized === "user" || normalized === "user.md" || normalized === "profile") {
    return { type: "persona", sceneName: "hermes_user_profile" };
  }

  return { type: "instruction", sceneName: "hermes_explicit_memory" };
}

export async function ingestExplicitMemory(params: ExplicitMemoryIngestParams): Promise<MemoryRecord | null> {
  const action = params.action.trim().toLowerCase();
  if (action !== "add") return null;

  const content = params.content.trim();
  if (!content) return null;

  const { type, sceneName } = classifyTarget(params.target);

  return writeMemory({
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
    logger: params.logger,
    vectorStore: params.vectorStore,
    embeddingService: params.embeddingService,
    requireVectorStoreWrite: true,
  });
}
