import type { ClaudeCodeDriverOptions } from "../drivers/claude-code.js";
import type { JsonRecord } from "../types.js";
import {
  MemoryWrapperRuntime,
  type MemoryWrapperOptions,
  readAbortSignal,
  streamRawWithMemory,
  withAbortController,
} from "./common.js";

export type ClaudeCodeQuery = NonNullable<ClaudeCodeDriverOptions["query"]>;

export interface ClaudeCodeMemoryOptions extends MemoryWrapperOptions {
  options?: JsonRecord;
}

export interface MemoryClaudeCode {
  readonly rawQuery: ClaudeCodeQuery;
  readonly memory: MemoryWrapperRuntime;
  query(input: { prompt: string; options?: JsonRecord }): AsyncIterable<unknown>;
  unwrap(): ClaudeCodeQuery;
  close(): Promise<void>;
  endMemorySession(sessionKey?: string): Promise<void>;
}

export function withClaudeCodeMemory(
  input: ClaudeCodeQuery | { query: ClaudeCodeQuery },
  options: ClaudeCodeMemoryOptions = {},
): MemoryClaudeCode {
  const rawQuery = typeof input === "function" ? input : input.query;
  const runtime = new MemoryWrapperRuntime("claude-code-sdk", options);

  return {
    rawQuery,
    memory: runtime,
    unwrap: () => rawQuery,
    close: () => runtime.close(),
    endMemorySession: (sessionKey?: string) => runtime.flush(sessionKey),
    query: (request) => {
      const mergedOptions = {
        ...(options.options ?? {}),
        ...(request.options ?? {}),
      };
      const signal = readAbortSignal(mergedOptions);
      return streamRawWithMemory({
        runtime,
        prompt: request.prompt,
        signal,
        invoke: (prompt, nextSignal) => rawQuery({
          prompt,
          options: withAbortController(mergedOptions, nextSignal),
        }),
      });
    },
  };
}
