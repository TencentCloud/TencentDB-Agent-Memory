import type { JsonRecord } from "../types.js";
import {
  MemoryWrapperRuntime,
  type MemoryWrapperOptions,
  readSignal,
  readStringPrompt,
  runRawWithMemory,
  streamRawWithMemory,
  withSignal,
} from "./common.js";

export interface CodexMemoryOptions extends MemoryWrapperOptions {
  sessionKeyFactory?: (threadOptions?: JsonRecord) => string;
}

type CodexThreadFactoryName = "startThread" | "createThread" | "thread";
type AwaitedReturn<T> = T extends Promise<infer U> ? U : T;
type FactoryThread<TClient, TName extends CodexThreadFactoryName> =
  TName extends keyof TClient
    ? TClient[TName] extends (...args: unknown[]) => infer TResult
      ? AwaitedReturn<TResult> extends object
        ? AwaitedReturn<TResult>
        : Record<string, unknown>
      : Record<string, unknown>
    : Record<string, unknown>;

export type MemoryCodexClient<TClient = unknown> =
  Omit<TClient, CodexThreadFactoryName> &
  MemoryCodexClientExtras<TClient> &
  MemoryCodexThreadFactoriesFor<TClient>;

export interface MemoryCodexClientExtras<TClient = unknown> {
  readonly rawClient: TClient;
  readonly memory: MemoryWrapperRuntime;
  unwrap(): TClient;
  close(): Promise<void>;
  endMemorySession(sessionKey?: string): Promise<void>;
}

export interface MemoryCodexThreadFactories {
  startThread<TThread extends object = Record<string, unknown>>(options?: JsonRecord): Promise<TThread & MemoryCodexThread<TThread>>;
  createThread<TThread extends object = Record<string, unknown>>(options?: JsonRecord): Promise<TThread & MemoryCodexThread<TThread>>;
  thread<TThread extends object = Record<string, unknown>>(options?: JsonRecord): Promise<TThread & MemoryCodexThread<TThread>>;
}

type MemoryCodexThreadFactoriesFor<TClient> = {
  startThread<TThread extends object = FactoryThread<TClient, "startThread">>(options?: JsonRecord): Promise<TThread & MemoryCodexThread<TThread>>;
  createThread<TThread extends object = FactoryThread<TClient, "createThread">>(options?: JsonRecord): Promise<TThread & MemoryCodexThread<TThread>>;
  thread<TThread extends object = FactoryThread<TClient, "thread">>(options?: JsonRecord): Promise<TThread & MemoryCodexThread<TThread>>;
};

export function withCodexMemory<TClient extends object>(
  client: TClient,
  options: CodexMemoryOptions = {},
): MemoryCodexClient<TClient> {
  const runtime = new MemoryWrapperRuntime("codex-sdk", options);
  const sessionKeyFactory = options.sessionKeyFactory;

  const extras: MemoryCodexClientExtras<TClient> = {
    rawClient: client,
    memory: runtime,
    unwrap: () => client,
    close: () => runtime.close(),
    endMemorySession: (sessionKey?: string) => runtime.flush(sessionKey),
  };

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop in extras) {
        return extras[prop as keyof MemoryCodexClientExtras<TClient>];
      }
      const value = Reflect.get(target, prop, receiver);
      if (isThreadFactoryName(prop) && typeof value === "function") {
        return async (...args: unknown[]) => {
          const threadOptions = isRecord(args[0]) ? args[0] : undefined;
          const thread = await value.apply(target, args);
          const sessionKey = sessionKeyFactory?.(threadOptions) ?? runtime.sessionKey;
          return wrapCodexThread(thread, runtime, sessionKey);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as MemoryCodexClient<TClient>;
}

export interface MemoryCodexThread<TThread = unknown> {
  readonly rawThread: TThread;
  readonly memory: MemoryWrapperRuntime;
  readonly sessionKey: string;
  unwrap(): TThread;
  endMemorySession(): Promise<void>;
}

export function wrapCodexThread<TThread extends object>(
  thread: TThread,
  runtime: MemoryWrapperRuntime,
  sessionKey = runtime.sessionKey,
): TThread & MemoryCodexThread<TThread> {
  const extras: MemoryCodexThread<TThread> = {
    rawThread: thread,
    memory: runtime,
    sessionKey,
    unwrap: () => thread,
    endMemorySession: () => runtime.flush(sessionKey),
  };

  return new Proxy(thread, {
    get(target, prop, receiver) {
      if (prop in extras) {
        return extras[prop as keyof MemoryCodexThread<TThread>];
      }
      const value = Reflect.get(target, prop, receiver);
      if (isStreamMethodName(prop) && typeof value === "function") {
        return (promptArg: unknown, optionsArg?: unknown, ...rest: unknown[]) => {
          const prompt = readStringPrompt(promptArg, `Codex thread.${String(prop)}()`);
          const signal = readSignal(optionsArg);
          return streamRawWithMemory({
            runtime,
            sessionKey,
            prompt,
            signal,
            invoke: (nextPrompt, nextSignal) => value.call(
              target,
              nextPrompt,
              withSignal(optionsArg, nextSignal),
              ...rest,
            ),
          });
        };
      }
      if (prop === "run" && typeof value === "function") {
        return async (promptArg: unknown, optionsArg?: unknown, ...rest: unknown[]) => {
          const prompt = readStringPrompt(promptArg, "Codex thread.run()");
          const signal = readSignal(optionsArg);
          return runRawWithMemory({
            runtime,
            sessionKey,
            prompt,
            signal,
            invoke: (nextPrompt, nextSignal) => value.call(
              target,
              nextPrompt,
              withSignal(optionsArg, nextSignal),
              ...rest,
            ),
          });
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as TThread & MemoryCodexThread<TThread>;
}

function isThreadFactoryName(prop: string | symbol): boolean {
  return prop === "startThread" || prop === "createThread" || prop === "thread";
}

function isStreamMethodName(prop: string | symbol): boolean {
  return prop === "runStreamed" || prop === "runStream" || prop === "stream";
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
