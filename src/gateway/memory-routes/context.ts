/**
 * MemoryRoutesContext — the dependency bundle that all /memory/* route
 * handlers receive. Split from memory-routes.ts (the shim) so each
 * per-route module can import it without creating a circular dependency
 * with the shim.
 */

import type { TdaiCore } from "../../core/tdai-core.js";
import type { GatewayConfig } from "../config.js";
import type { LoopbackTokenManager } from "../token.js";
import type { Logger } from "../../core/types.js";

export interface MemoryRoutesContext {
  core: TdaiCore;
  config: GatewayConfig;
  tokenManager: LoopbackTokenManager;
  logger: Logger;
  version: string;
}
