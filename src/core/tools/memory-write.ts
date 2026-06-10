/**
 * tdai_memory_write tool: explicit long-term memory insertion.
 *
 * This is intentionally store-only. It does not update or merge existing
 * memories, so direct writes cannot silently rewrite L1 records while bypassing
 * the L1 extraction conflict-resolution prompt.
 */

import type { IMemoryStore } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { Logger } from "../types.js";
import { generateMemoryId, writeMemory, type MemoryRecord, type MemoryType } from "../record/l1-writer.js";

const VALID_TYPES: MemoryType[] = ["persona", "episodic", "instruction"];
const DEFAULT_TYPE: MemoryType = "episodic";
const DEFAULT_SCENE = "manual";
const DEFAULT_PRIORITY = 50;
const MAX_CONTENT_CHARS = 4000;
const TAG = "[memory-tdai][tdai_memory_write]";

export interface MemoryWriteParams {
  content: string;
  type?: string;
  sceneName?: string;
  sessionKey?: string;
  sessionId?: string;
}

export interface MemoryWriteResult {
  record: MemoryRecord;
  text: string;
}

export async function executeMemoryWrite(opts: {
  params: MemoryWriteParams;
  dataDir: string;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  logger?: Logger;
}): Promise<MemoryWriteResult> {
  const content = normalizeContent(opts.params.content);
  const type = normalizeType(opts.params.type);
  const sceneName = normalizeSceneName(opts.params.sceneName);
  const sessionKey = normalizeSessionKey(opts.params.sessionKey);
  const sessionId = opts.params.sessionId?.trim() ?? "";
  const now = new Date().toISOString();
  const recordId = generateMemoryId();

  const record = await writeMemory({
    memory: {
      content,
      type,
      priority: DEFAULT_PRIORITY,
      scene_name: sceneName,
      source_message_ids: [`manual:${recordId}`],
      metadata: {
        source: "tdai_memory_write",
        written_at: now,
      },
    },
    decision: {
      record_id: recordId,
      action: "store",
      target_ids: [],
    },
    baseDir: opts.dataDir,
    sessionKey,
    sessionId,
    logger: opts.logger,
    vectorStore: opts.vectorStore,
    embeddingService: opts.embeddingService,
  });

  if (!record) {
    throw new Error("Memory write returned no record");
  }

  opts.logger?.debug?.(
    `${TAG} Stored memory id=${record.id} type=${record.type} scene=${record.scene_name} ` +
    `sessionKey=${record.sessionKey} contentLen=${record.content.length}`,
  );

  return {
    record,
    text: `Memory written: ${record.id} (${record.type}, scene=${record.scene_name})`,
  };
}

function normalizeContent(raw: string): string {
  const content = String(raw ?? "").trim();
  if (!content) {
    throw new Error("content is required");
  }
  if (content.length > MAX_CONTENT_CHARS) {
    throw new Error(`content is too long (max ${MAX_CONTENT_CHARS} characters)`);
  }
  return content;
}

function normalizeType(raw: string | undefined): MemoryType {
  if (!raw) return DEFAULT_TYPE;
  const normalized = raw.trim().toLowerCase();
  if (VALID_TYPES.includes(normalized as MemoryType)) {
    return normalized as MemoryType;
  }
  throw new Error(`Invalid memory type "${raw}". Expected one of: ${VALID_TYPES.join(", ")}`);
}

function normalizeSceneName(raw: string | undefined): string {
  const sceneName = raw?.trim();
  return sceneName || DEFAULT_SCENE;
}

function normalizeSessionKey(raw: string | undefined): string {
  const sessionKey = raw?.trim();
  return sessionKey || "manual-write";
}
