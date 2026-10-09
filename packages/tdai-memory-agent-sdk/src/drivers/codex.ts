import type {
  AgentSdkDriver,
  AgentSdkRunInput,
  AgentSdkRunResult,
  AgentSdkSession,
  AgentSdkSessionOptions,
  JsonRecord,
} from "../types.js";
import { runFromStream, streamFromUnknownResult } from "./common.js";

export interface CodexDriverOptions {
  client?: unknown;
  clientOptions?: JsonRecord;
  threadOptions?: JsonRecord;
  runOptions?: JsonRecord;
}

export function createCodexDriver(options: CodexDriverOptions = {}): AgentSdkDriver {
  return new CodexDriver(options);
}

class CodexDriver implements AgentSdkDriver {
  readonly name = "codex-sdk";

  constructor(private readonly options: CodexDriverOptions) {}

  async startSession(sessionOptions?: AgentSdkSessionOptions): Promise<AgentSdkSession> {
    const client = this.options.client ?? await createCodexClient(this.options.clientOptions);
    const thread = await createThread(client, {
      ...(this.options.threadOptions ?? {}),
      ...(sessionOptions?.metadata ?? {}),
    });
    return new CodexSession(thread, this.options.runOptions);
  }
}

class CodexSession implements AgentSdkSession {
  constructor(
    private readonly thread: unknown,
    private readonly runOptions?: JsonRecord,
  ) {}

  async *stream(input: AgentSdkRunInput) {
    const target = this.thread;
    const options = { ...(this.runOptions ?? {}), signal: input.signal };

    if (hasFunction(target, "stream")) {
      yield* streamFromUnknownResult(await target.stream(input.prompt, options));
      return;
    }
    if (hasFunction(target, "runStreamed")) {
      yield* streamFromUnknownResult(await target.runStreamed(input.prompt, options));
      return;
    }
    if (hasFunction(target, "runStream")) {
      yield* streamFromUnknownResult(await target.runStream(input.prompt, options));
      return;
    }
    if (hasFunction(target, "run")) {
      yield* streamFromUnknownResult(await target.run(input.prompt, options));
      return;
    }
    throw new Error("Codex SDK thread does not expose stream(), runStream(), or run().");
  }

  run(input: AgentSdkRunInput): Promise<AgentSdkRunResult> {
    return runFromStream(this, input);
  }
}

async function createCodexClient(options?: JsonRecord): Promise<unknown> {
  let mod: Record<string, unknown>;
  try {
    mod = await import("@openai/codex-sdk") as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      "Missing optional peer dependency @openai/codex-sdk. " +
      "Install it to use createCodexDriver().",
      { cause: error },
    );
  }

  const CodexCtor = mod.Codex ?? mod.default;
  if (typeof CodexCtor !== "function") {
    throw new Error("@openai/codex-sdk does not export a Codex constructor.");
  }
  return new (CodexCtor as new (options?: JsonRecord) => unknown)(options);
}

async function createThread(client: unknown, options: JsonRecord): Promise<unknown> {
  if (hasFunction(client, "startThread")) {
    return client.startThread(options);
  }
  if (hasFunction(client, "createThread")) {
    return client.createThread(options);
  }
  if (hasFunction(client, "thread")) {
    return client.thread(options);
  }
  throw new Error("Codex SDK client does not expose startThread(), createThread(), or thread().");
}

function hasFunction<T extends string>(value: unknown, key: T): value is Record<T, (...args: unknown[]) => unknown> {
  return value !== null && typeof value === "object" && typeof (value as Record<string, unknown>)[key] === "function";
}
