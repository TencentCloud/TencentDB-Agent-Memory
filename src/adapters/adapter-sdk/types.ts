import type {
  CaptureRequest,
  CaptureResponse,
  ConversationSearchRequest,
  ConversationSearchResponse,
  HealthResponse,
  MemorySearchRequest,
  MemorySearchResponse,
  RecallRequest,
  RecallResponse,
} from "../../gateway/types.js";

export type Logger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type RecallInput = RecallRequest;
export type CaptureInput = CaptureRequest;
export type RecallResult = RecallResponse;
export type CaptureResult = CaptureResponse & {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
};

export type MemorySearchInput = MemorySearchRequest;
export type MemorySearchResult = MemorySearchResponse;
export type ConversationSearchInput = ConversationSearchRequest;
export type ConversationSearchResult = ConversationSearchResponse;
export type GatewayHealth = HealthResponse;

export interface PromptCache {
  get(sessionKey: string): string | null;
  set(sessionKey: string, prompt: string): void;
  delete(sessionKey: string): void;
  cleanup?(): void;
}

export interface MemoryPlatformAdapter<
  RecallEvent = unknown,
  CaptureEvent = unknown,
  RecallOutput = unknown,
  CaptureOutput = unknown,
> {
  readonly platform: string;
  parseRecall(event: RecallEvent, cache: PromptCache): RecallInput | null;
  formatRecall(result: RecallResult): RecallOutput;
  parseCapture(event: CaptureEvent, cache: PromptCache): CaptureInput | null;
  formatCapture(result: CaptureResult): CaptureOutput;
}

export interface GatewayClientOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

export interface HookRunnerOptions {
  gatewayUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  cache?: PromptCache;
  logger?: Logger;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}
