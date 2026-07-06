/**
 * Adapter SDK — barrel.
 *
 * One import gives a new platform everything it needs:
 *
 *   import {
 *     createMemoryClient,
 *     BasePlatformAdapter,
 *     type MemoryClient,
 *   } from ".../src/adapter-sdk/index.js";
 *
 * NOTE: this barrel intentionally never imports `src/adapters/index.ts` or
 * root `index.ts` — those pull in the (optional, often absent) `openclaw`
 * peer dependency. The SDK must stay loadable in gateway-only installs.
 */

export type {
  MemoryClient,
  PlatformAdapter,
  TdaiCoreLike,
  RecallParams,
  RecallOutcome,
  CaptureParams,
  CaptureOutcome,
  SearchMemoriesParams,
  SearchMemoriesOutcome,
  SearchConversationsParams,
  SearchConversationsOutcome,
  HealthOutcome,
} from "./types.js";

export { MemoryClientError, codeForHttpStatus } from "./errors.js";
export type { MemoryClientErrorCode } from "./errors.js";

export { createMemoryClient, resolveClientOptionsFromEnv } from "./factory.js";
export type {
  MemoryClientOptions,
  HttpClientOptions,
  InProcessClientOptions,
} from "./factory.js";

export { BasePlatformAdapter } from "./base-platform-adapter.js";
export type { BasePlatformAdapterOptions } from "./base-platform-adapter.js";

export { HttpMemoryClient } from "./transports/http.js";
export type { HttpMemoryClientOptions } from "./transports/http.js";
export { InProcessMemoryClient } from "./transports/in-process.js";
export type { InProcessMemoryClientOptions } from "./transports/in-process.js";
