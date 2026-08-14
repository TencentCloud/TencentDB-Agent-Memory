import { defaultAdapterOperationStateDir, FileAdapterOperationStore } from "./operation-store.js";
import { SessionQueue } from "./session-queue.js";
import type {
  AdapterRuntime,
  AdapterRuntimeOptions,
  CaptureResponse,
  EndSessionResponse,
} from "./types.js";

export function createAdapterRuntime(options: AdapterRuntimeOptions): AdapterRuntime {
  const operationStore = options.operationStore ?? new FileAdapterOperationStore({
    stateDir: defaultAdapterOperationStateDir(options.platform),
  });
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const queue = new SessionQueue();

  const recallOutcome: AdapterRuntime["recallOutcome"] = async (input) => {
    try {
      const result = await options.client.recall(input);
      const context = result.context.trim();
      return { ok: true, result: context ? { ...result, context } : undefined };
    } catch (error) {
      log(`[${options.platform}] recall failed open: ${errorMessage(error)}`);
      return { ok: false };
    }
  };

  const runIdempotent = async <T>(
    kind: "capture" | "session end",
    sessionKey: string,
    operationId: string,
    operation: () => Promise<T>,
  ): Promise<T | undefined> => {
    const operationKey = `${options.platform}\0${kind}\0${sessionKey}\0${operationId}`;
    if (!await operationStore.claim(operationKey)) return undefined;
    try {
      const result = await operation();
      await operationStore.complete(operationKey);
      return result;
    } catch (error) {
      await operationStore.release(operationKey);
      log(`[${options.platform}] ${kind} failed open: ${errorMessage(error)}`);
      return undefined;
    }
  };

  return {
    async recall(input) {
      const outcome = await recallOutcome(input);
      return outcome.ok ? outcome.result : undefined;
    },

    recallOutcome,

    capture(input): Promise<CaptureResponse | undefined> {
      const { operationId, ...request } = input;
      return runIdempotent("capture", input.sessionKey, operationId, () => options.client.capture(request));
    },

    endSession(input): Promise<EndSessionResponse | undefined> {
      const { operationId, ...request } = input;
      return runIdempotent("session end", input.sessionKey, operationId, () => options.client.endSession(request));
    },

    runExclusive(sessionKey, operation) {
      return queue.run(sessionKey, operation);
    },

    async dispose(timeoutMs = 5_000) {
      const result = await queue.dispose(timeoutMs);
      if (result === "timeout") {
        log(`[${options.platform}] dispose timed out after ${timeoutMs}ms waiting for session queues`);
      }
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}