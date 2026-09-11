export interface RecallRequest {
  query: string;
  sessionKey: string;
}

export interface RecallResponse {
  context: string;
  strategy?: string;
  memoryCount: number;
}

export interface CaptureRequest {
  userContent: string;
  assistantContent: string;
  sessionKey: string;
  sessionId?: string;
  messages?: unknown[];
}

export interface CaptureResponse {
  l0Recorded: number;
  schedulerNotified: boolean;
}

export interface EndSessionRequest {
  sessionKey: string;
}

export interface EndSessionResponse {
  flushed: boolean;
}

export interface SearchMemoriesRequest {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

export interface SearchMemoriesResponse {
  results: string;
  total: number;
  strategy: string;
}

export interface SearchConversationsRequest {
  query: string;
  limit?: number;
  sessionKey?: string;
}

export interface SearchConversationsResponse {
  results: string;
  total: number;
}

export interface MemoryClient {
  recall(input: RecallRequest): Promise<RecallResponse>;
  capture(input: CaptureRequest): Promise<CaptureResponse>;
  endSession(input: EndSessionRequest): Promise<EndSessionResponse>;
  searchMemories(input: SearchMemoriesRequest): Promise<SearchMemoriesResponse>;
  searchConversations(input: SearchConversationsRequest): Promise<SearchConversationsResponse>;
}

export interface AdapterOperationStore {
  claim(key: string): Promise<boolean>;
  complete(key: string): Promise<void>;
  release(key: string): Promise<void>;
}

export type AdapterLogger = (message: string) => void;

export type RecallOutcome =
  | { ok: true; result: RecallResponse | undefined }
  | { ok: false };

export interface AdapterCaptureRequest extends CaptureRequest {
  operationId: string;
}

export interface AdapterEndSessionRequest extends EndSessionRequest {
  operationId: string;
}

export interface AdapterRuntime {
  recall(input: RecallRequest): Promise<RecallResponse | undefined>;
  recallOutcome(input: RecallRequest): Promise<RecallOutcome>;
  capture(input: AdapterCaptureRequest): Promise<CaptureResponse | undefined>;
  endSession(input: AdapterEndSessionRequest): Promise<EndSessionResponse | undefined>;
  runExclusive<T>(sessionKey: string, operation: () => Promise<T>): Promise<T | undefined>;
  dispose(timeoutMs?: number): Promise<void>;
}

export interface PlatformAdapter<TBindings> {
  readonly platform: string;
  create(runtime: AdapterRuntime): TBindings | Promise<TBindings>;
}

export interface AdapterRuntimeOptions {
  platform: string;
  client: MemoryClient;
  operationStore?: AdapterOperationStore;
  log?: AdapterLogger;
}