import type {
  AgentSdkDriver,
  AgentSdkRunInput,
  AgentSdkRunResult,
  AgentSdkSession,
  AgentSdkSessionOptions,
  JsonRecord,
} from "../types.js";
import { runFromStream, streamFromUnknownResult, withAbortController } from "./common.js";

export interface ClaudeCodeDriverOptions {
  query?: (input: { prompt: string; options?: JsonRecord }) => AsyncIterable<unknown> | Promise<unknown> | unknown;
  options?: JsonRecord;
}

export function createClaudeCodeDriver(options: ClaudeCodeDriverOptions = {}): AgentSdkDriver {
  return new ClaudeCodeDriver(options);
}

class ClaudeCodeDriver implements AgentSdkDriver {
  readonly name = "claude-code-sdk";

  constructor(private readonly options: ClaudeCodeDriverOptions) {}

  async startSession(sessionOptions?: AgentSdkSessionOptions): Promise<AgentSdkSession> {
    const query = this.options.query ?? await loadClaudeQuery();
    return new ClaudeCodeSession(query, {
      ...(this.options.options ?? {}),
      ...(sessionOptions?.metadata ?? {}),
    });
  }
}

class ClaudeCodeSession implements AgentSdkSession {
  constructor(
    private readonly query: NonNullable<ClaudeCodeDriverOptions["query"]>,
    private readonly options?: JsonRecord,
  ) {}

  async *stream(input: AgentSdkRunInput) {
    const result = this.query({
      prompt: input.prompt,
      options: withAbortController(this.options ?? {}, input.signal),
    });
    yield* streamFromUnknownResult(result);
  }

  run(input: AgentSdkRunInput): Promise<AgentSdkRunResult> {
    return runFromStream(this, input);
  }
}

async function loadClaudeQuery(): Promise<NonNullable<ClaudeCodeDriverOptions["query"]>> {
  let mod: Record<string, unknown>;
  try {
    mod = await import("@anthropic-ai/claude-agent-sdk") as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      "Missing optional peer dependency @anthropic-ai/claude-agent-sdk. " +
      "Install it to use createClaudeCodeDriver().",
      { cause: error },
    );
  }

  if (typeof mod.query !== "function") {
    throw new Error("@anthropic-ai/claude-agent-sdk does not export query().");
  }
  return mod.query as NonNullable<ClaudeCodeDriverOptions["query"]>;
}
