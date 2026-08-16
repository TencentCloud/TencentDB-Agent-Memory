/**
 * eval-memory — shared types.
 *
 * The harness replays a benchmark dataset through a standalone Gateway
 * (ingest → settle → answer → judge) and reports judged accuracy with the
 * run metadata needed to make independent reproductions comparable
 * (see docs/reproducible-memory-evaluation.md once merged, and issue #106).
 *
 * Pipeline design follows mem0ai/memory-benchmarks (Apache-2.0):
 * https://github.com/mem0ai/memory-benchmarks
 */

export type QuestionCategory =
  | "single-hop"
  | "multi-hop"
  | "temporal"
  | "open-domain"
  | "adversarial";

export interface EvalTurn {
  role: "user" | "assistant";
  content: string;
}

/** One multi-turn session inside a conversation (one /capture per round). */
export interface EvalSession {
  sessionKey: string;
  /** Human-readable date the session took place ("1:56 pm on 8 May, 2023"). */
  dateTime?: string;
  /** Strictly alternating user/assistant rounds, normalized by the adapter. */
  rounds: Array<{ user: string; assistant: string }>;
}

export interface EvalQuestion {
  id: string;
  question: string;
  goldAnswer: string;
  category: QuestionCategory;
  /** Dialog ids that contain the answer, when the dataset provides them. */
  evidence?: string[];
}

/**
 * One independent memory scope. Each conversation is evaluated against a
 * fresh Gateway data directory so memories from other conversations cannot
 * leak into recall (mirrors the one-agent-per-user deployment shape).
 */
export interface EvalConversation {
  conversationId: string;
  sessions: EvalSession[];
  questions: EvalQuestion[];
}

export interface EvalDataset {
  name: string;
  /** Where the data came from (URL or path) — recorded in the report. */
  source: string;
  conversations: EvalConversation[];
}

// ============================
// Gateway seam (DI for tests)
// ============================

export interface RecallResult {
  context: string;
  strategy?: string;
  memoryCount: number;
  /** Non-zero recall failure code (H-15 taxonomy) — recorded, not fatal. */
  code: number;
  message?: string;
}

export interface PipelineLayerStatus {
  queued: number;
  running: number;
  idle: boolean;
}

export interface PipelineStatus {
  l1: PipelineLayerStatus;
  l2: PipelineLayerStatus;
  l3: PipelineLayerStatus;
}

/** Minimal Gateway surface the runner needs. Real impl is HTTP; tests fake it. */
export interface EvalGateway {
  capture(sessionKey: string, user: string, assistant: string): Promise<void>;
  sessionEnd(sessionKey: string): Promise<void>;
  /** null = endpoint unavailable (legacy standalone) — settle falls back to a fixed grace wait. */
  pipelineStatus(): Promise<PipelineStatus | null>;
  recall(query: string, sessionKey: string): Promise<RecallResult>;
  /** Total L1 records extracted, when countable; null when not supported. */
  countL1(): Promise<number | null>;
  close(): Promise<void>;
}

/** Creates a fresh, isolated gateway scope per conversation. */
export type EvalGatewayFactory = (conversationId: string) => Promise<EvalGateway>;

// ============================
// LLM seam (DI for tests)
// ============================

export interface JudgeVerdict {
  correct: boolean;
  reason: string;
}

export interface EvalLlm {
  /** Answer a question given only the provided context. */
  answer(question: string, context: string, mode: "memory" | "baseline"): Promise<string>;
  /** Grade a generated answer against the gold answer. */
  judge(question: string, goldAnswer: string, generated: string): Promise<JudgeVerdict>;
}

// ============================
// Results
// ============================

export interface QuestionResult {
  conversationId: string;
  questionId: string;
  category: QuestionCategory;
  question: string;
  goldAnswer: string;
  memory: AnswerOutcome;
  /** Present only when --baseline full-context was requested. */
  baseline?: AnswerOutcome;
}

export interface AnswerOutcome {
  answer: string;
  correct: boolean;
  judgeReason: string;
  contextChars: number;
  contextTokens: number;
  recallStrategy?: string;
  recallMemoryCount?: number;
  recallCode?: number;
  latencyMs: number;
}

export interface CategoryScore {
  category: QuestionCategory | "overall";
  total: number;
  memoryCorrect: number;
  memoryAccuracy: number;
  baselineCorrect?: number;
  baselineAccuracy?: number;
  avgMemoryContextTokens: number;
  avgBaselineContextTokens?: number;
}

export interface ConversationRunStats {
  conversationId: string;
  sessions: number;
  rounds: number;
  l1Records: number | null;
  ingestMs: number;
  settleMs: number;
  settled: boolean;
}

export interface RunReport {
  metadata: RunMetadata;
  scores: CategoryScore[];
  conversations: ConversationRunStats[];
  results: QuestionResult[];
}

export interface RunMetadata {
  harnessVersion: string;
  startedAt: string;
  finishedAt: string;
  repoCommit: string;
  nodeVersion: string;
  platform: string;
  dataset: { name: string; source: string; conversations: number; sessions: number; questions: number };
  models: { extraction: string; answer: string; judge: string };
  gateway: { mode: "spawned" | "external"; url: string; configPath?: string };
  flags: Record<string, string | number | boolean>;
}
