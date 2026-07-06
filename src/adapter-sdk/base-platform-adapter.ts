/**
 * Adapter SDK — BasePlatformAdapter.
 *
 * Abstract convenience base for `PlatformAdapter` implementations. Provides:
 *   - the shared `MemoryClient` reference (`this.client`)
 *   - a tagged default logger
 *   - `stop()` that closes the client (override + `super.stop()` to add
 *     platform teardown)
 *   - `safeRecall` / `safeCapture`: never-throw wrappers implementing the
 *     project's resilience philosophy (mirrored from the Hermes provider):
 *     **memory must never break the host conversation.** A failed recall
 *     degrades to "no context"; a failed capture is logged and dropped.
 *
 * A new platform therefore only implements `platformName` and `start()`.
 */

import type { Logger } from "../core/types.js";
import type {
  MemoryClient,
  PlatformAdapter,
  RecallParams,
  RecallOutcome,
  CaptureParams,
  CaptureOutcome,
} from "./types.js";

const TAG = "[tdai-adapter]";

export interface BasePlatformAdapterOptions {
  /** The memory client this adapter consumes (from `createMemoryClient`). */
  client: MemoryClient;
  logger?: Logger;
}

export abstract class BasePlatformAdapter implements PlatformAdapter {
  protected readonly client: MemoryClient;
  protected readonly logger: Logger;

  constructor(opts: BasePlatformAdapterOptions) {
    this.client = opts.client;
    this.logger = opts.logger ?? {
      debug: (msg: string) => console.debug(`${TAG} ${msg}`),
      info: (msg: string) => console.info(`${TAG} ${msg}`),
      warn: (msg: string) => console.warn(`${TAG} ${msg}`),
      error: (msg: string) => console.error(`${TAG} ${msg}`),
    };
  }

  abstract readonly platformName: string;

  abstract start(): Promise<void>;

  /** Default teardown: close the memory client. Override to add more. */
  async stop(): Promise<void> {
    await this.client.close();
  }

  /**
   * Recall that never throws: on failure logs a warning and returns an empty
   * outcome so the host turn proceeds without memory context.
   */
  protected async safeRecall(params: RecallParams): Promise<RecallOutcome> {
    try {
      return await this.client.recall(params);
    } catch (err) {
      this.logger.warn(
        `${TAG} [${this.platformName}] recall failed (degrading to empty context): ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      return { context: "", memoryCount: 0 };
    }
  }

  /**
   * Capture that never throws: on failure logs a warning and returns
   * `undefined` (the turn is simply not remembered).
   */
  protected async safeCapture(params: CaptureParams): Promise<CaptureOutcome | undefined> {
    try {
      return await this.client.capture(params);
    } catch (err) {
      this.logger.warn(
        `${TAG} [${this.platformName}] capture failed (turn dropped from memory): ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }
}
