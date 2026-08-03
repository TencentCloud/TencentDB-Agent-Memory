/**
 * L1 extraction shared types + memory type normalization.
 * Split from l1-extractor.ts (560 lines) to keep modules ≤150 lines.
 */
import type { MemoryRecord, MemoryType } from "./l1-writer.js";
import type { ConversationMessage } from "../conversation/l0-recorder.js";
import type { IMemoryStore } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { LLMRunner, Logger } from "../types.js";

// ============================
// Types
// ============================

/** A scene segment with its extracted memories (LLM output) */
export interface SceneSegment {
  scene_name: string;
  message_ids: string[];
  memories: Array<{
    content: string;
    type: string;
    /** Raw scope from the model — normalized to 'global'|'project' later (I3). */
    scope: string;
    priority: number;
    source_message_ids: string[];
    metadata: Record<string, unknown>;
  }>;
}

export interface L1ExtractionResult {
  /** Whether extraction succeeded */
  success: boolean;
  /** Number of memories extracted */
  extractedCount: number;
  /** Number of memories actually stored (after dedup) */
  storedCount: number;
  /** The memory records that were stored */
  records: MemoryRecord[];
  /** Scene names detected during extraction */
  sceneNames: string[];
  /** Last scene name (for continuity in next extraction) */
  lastSceneName?: string;
  /** Failure reason when success === false */
  error?: string;
}

export interface ExtractL1Params {
  messages: ConversationMessage[];
  sessionKey: string;
  sessionId?: string;
  /** Project these messages came from (git-root of cwd); '' when unknown. */
  projectId?: string;
  baseDir: string;
  config: unknown;
  options?: {
    /** Max new messages to send in one extraction call */
    maxMessagesPerExtraction?: number;
    /** Max background messages for context */
    maxBackgroundMessages?: number;
    /** Enable conflict detection */
    enableDedup?: boolean;
    /** Max memories extracted per call */
    maxMemoriesPerSession?: number;
    /** LLM model override */
    model?: string;
    /** Previous scene name for continuity */
    previousSceneName?: string;
    /** Vector store for cosine similarity candidate recall */
    vectorStore?: IMemoryStore;
    /** Embedding service for computing query vectors */
    embeddingService?: EmbeddingService;
    /** Top-K candidates for conflict recall (default: 5) */
    conflictRecallTopK?: number;
    /** Override embedding timeout for capture-path calls (milliseconds) */
    embeddingTimeoutMs?: number;
    /**
     * Host-neutral LLM runner. When provided, used instead of creating
     * a CleanContextRunner (decouples from OpenClaw runtime).
     */
    llmRunner?: LLMRunner;
  };
  logger?: Logger;
  /** Plugin instance ID for metric reporting (optional — metrics skipped if absent) */
  instanceId?: string;
}

// ============================
// Memory type normalization
// ============================

const VALID_TYPES: MemoryType[] = ["persona", "episodic", "instruction"];

export function normalizeType(raw: string): MemoryType | null {
  const lower = raw.toLowerCase().trim();
  if (VALID_TYPES.includes(lower as MemoryType)) {
    return lower as MemoryType;
  }
  // Handle legacy type names
  if (lower === "episode") return "episodic";
  if (lower === "instruct") return "instruction";
  if (lower === "preference") return "persona"; // fold preference into persona
  return null;
}
