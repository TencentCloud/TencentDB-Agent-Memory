/**
 * memory_write tool: Agent-callable explicit L1 memory writer.
 *
 * This is intentionally narrow: callers provide the final memory content.
 * The tool does not summarize, infer, deduplicate, or resolve conflicts.
 */

import { generateMemoryId, writeMemory } from "../record/l1-writer.js";
import type { ExtractedMemory, MemoryRecord, MemoryType } from "../record/l1-writer.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { IMemoryStore } from "../store/types.js";
import type { Logger } from "../types.js";

export interface MemoryWriteResult {
  record: MemoryRecord;
  text: string;
}

export interface ExecuteMemoryWriteParams {
  content: string;
  baseDir: string;
  type?: string;
  sceneName?: string;
  priority?: number;
  sessionKey?: string;
  sessionId?: string;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  logger?: Logger;
}

const TAG = "[memory-tdai][tdai_memory_write]";
const MAX_CONTENT_CHARS = 5000;
const VALID_TYPES: MemoryType[] = ["persona", "episodic", "instruction"];

export async function executeMemoryWrite(params: ExecuteMemoryWriteParams): Promise<MemoryWriteResult> {
  const content = normalizeContent(params.content);
  const type = normalizeType(params.type);
  const priority = normalizePriority(params.priority, type);
  const sceneName = normalizeOptionalString(params.sceneName) ?? "manual";
  const sessionKey = normalizeOptionalString(params.sessionKey) ?? "manual-tool-write";
  const sessionId = normalizeOptionalString(params.sessionId) ?? "";
  const recordId = generateMemoryId();

  const memory: ExtractedMemory = {
    content,
    type,
    priority,
    scene_name: sceneName,
    source_message_ids: [`tool:${recordId}`],
    metadata: {},
  };

  const record = await writeMemory({
    memory,
    decision: {
      record_id: recordId,
      action: "store",
      target_ids: [],
    },
    baseDir: params.baseDir,
    sessionKey,
    sessionId,
    logger: params.logger,
    vectorStore: params.vectorStore,
    embeddingService: params.embeddingService,
  });

  if (!record) {
    throw new Error("Memory write was skipped unexpectedly");
  }

  params.logger?.debug?.(
    `${TAG} stored id=${record.id}, type=${record.type}, priority=${record.priority}, ` +
    `sessionKey=${record.sessionKey}, contentLen=${record.content.length}`,
  );

  return {
    record,
    text: formatMemoryWriteResponse(record),
  };
}

export function formatMemoryWriteResponse(record: MemoryRecord): string {
  return [
    `Stored memory ${record.id}.`,
    `Type: ${record.type}`,
    `Priority: ${record.priority}`,
    `Scene: ${record.scene_name}`,
    `Content: ${record.content}`,
  ].join("\n");
}

function normalizeContent(raw: string): string {
  const content = raw.trim();
  if (!content) {
    throw new Error("Memory content is required");
  }
  if (content.length > MAX_CONTENT_CHARS) {
    throw new Error(`Memory content is too long (max ${MAX_CONTENT_CHARS} characters)`);
  }
  return content;
}

function normalizeType(raw: string | undefined): MemoryType {
  const type = normalizeOptionalString(raw) ?? "episodic";
  if (!VALID_TYPES.includes(type as MemoryType)) {
    throw new Error(`Invalid memory type "${type}". Expected one of: ${VALID_TYPES.join(", ")}`);
  }
  return type as MemoryType;
}

function normalizePriority(raw: number | undefined, type: MemoryType): number {
  if (raw == null) {
    if (type === "instruction") return 80;
    if (type === "persona") return 70;
    return 60;
  }
  if (!Number.isFinite(raw) || raw < 0 || raw > 100) {
    throw new Error("Memory priority must be a finite number between 0 and 100");
  }
  return Math.round(raw);
}

function normalizeOptionalString(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}
