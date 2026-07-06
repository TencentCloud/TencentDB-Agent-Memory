import { GatewayClient } from "./gateway-client.js";
import { FilePromptCache } from "./prompt-cache.js";
import type {
  CaptureResult,
  HookRunnerOptions,
  MemoryPlatformAdapter,
  RecallResult,
} from "./types.js";

async function readJson<T>(stdin: NodeJS.ReadableStream): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T;
}

function writeJson(stdout: NodeJS.WritableStream, value: unknown): void {
  stdout.write(JSON.stringify(value));
}

export async function runRecallHook<RecallEvent, RecallOutput>(
  adapter: MemoryPlatformAdapter<RecallEvent, unknown, RecallOutput, unknown>,
  opts: HookRunnerOptions = {},
): Promise<void> {
  const stdout = opts.stdout ?? process.stdout;
  const logger = opts.logger;
  const cache = opts.cache ?? new FilePromptCache();

  try {
    const event = await readJson<RecallEvent>(opts.stdin ?? process.stdin);
    cache.cleanup?.();

    const input = adapter.parseRecall(event, cache);
    if (!input) {
      writeJson(stdout, adapter.formatRecall(emptyRecall()));
      return;
    }

    const gateway = new GatewayClient({
      baseUrl: opts.gatewayUrl,
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs ?? 10_000,
      logger,
    });
    const result = await gateway.recall(input);
    writeJson(stdout, adapter.formatRecall(result));
  } catch (err) {
    logger?.warn?.(`Recall hook degraded: ${err instanceof Error ? err.message : String(err)}`);
    writeJson(stdout, adapter.formatRecall(emptyRecall()));
  }
}

export async function runCaptureHook<CaptureEvent, CaptureOutput>(
  adapter: MemoryPlatformAdapter<unknown, CaptureEvent, unknown, CaptureOutput>,
  opts: HookRunnerOptions = {},
): Promise<void> {
  const stdout = opts.stdout ?? process.stdout;
  const logger = opts.logger;
  const cache = opts.cache ?? new FilePromptCache();

  try {
    const event = await readJson<CaptureEvent>(opts.stdin ?? process.stdin);
    const input = adapter.parseCapture(event, cache);
    if (!input) {
      writeJson(stdout, adapter.formatCapture(skippedCapture("adapter returned null")));
      return;
    }

    const gateway = new GatewayClient({
      baseUrl: opts.gatewayUrl,
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs ?? 30_000,
      logger,
    });
    const result = await gateway.capture(input);
    cache.delete(input.session_key);
    writeJson(stdout, adapter.formatCapture(result));
  } catch (err) {
    logger?.warn?.(`Capture hook degraded: ${err instanceof Error ? err.message : String(err)}`);
    writeJson(stdout, adapter.formatCapture(skippedCapture("gateway unavailable")));
  }
}

function emptyRecall(): RecallResult {
  return { context: "", memory_count: 0 };
}

function skippedCapture(reason: string): CaptureResult {
  return {
    ok: false,
    skipped: true,
    reason,
    l0_recorded: 0,
    scheduler_notified: false,
  };
}
