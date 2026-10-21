/**
 * Offload V2 Router — route registration and dispatch.
 */
import type http from "node:http";
import type { StorageAdapter } from "../core/storage/adapter.js";
import type { IStateBackend } from "../core/state/types.js";
import type { OffloadExecutorConfig } from "./types.js";
import { defaultOffloadConfig } from "./types.js";
import { parseV2Auth, successEnvelope, errorEnvelope, makeRequestId } from "../gateway/v2-router.js";
import { resolveOffloadMaxBodyBytes } from "../utils/env-config.js";
import { handleIngest } from "./ingest-handler.js";
import { handleMmdQuery } from "./mmd-handler.js";
import { handleCompaction } from "./compact/compaction-handler.js";
import { MmdQuerySchema } from "./schemas.js";

export interface OffloadV2Deps {
  resolveStorage?: (instanceId: string) => Promise<StorageAdapter | undefined>;
  getStorage: () => StorageAdapter | undefined;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  stateBackend?: IStateBackend;
  config?: OffloadExecutorConfig;
}

/** Body limit is resolved once; most routes keep the injected default. */
const OFFLOAD_MAX_BODY_BYTES = resolveOffloadMaxBodyBytes();

/**
 * Handle offload V2 routes. Returns true if the request was handled.
 */
export async function handleOffloadV2Route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  parseJsonBody: <T>(req: http.IncomingMessage, maxBytes?: number) => Promise<T>,
  sendJson: (res: http.ServerResponse, status: number, body: unknown) => void,
  deps: OffloadV2Deps,
): Promise<boolean> {
  if (!pathname.startsWith("/v2/offload/")) return false;

  const requestId = makeRequestId();

  // Auth
  const auth = parseV2Auth(req, res, requestId, sendJson);
  if (!auth) return true; // 401 already sent

  // Resolve storage
  const storage =
    (await deps.resolveStorage?.(auth.serviceId)) ?? deps.getStorage();
  if (!storage) {
    sendJson(res, 503, errorEnvelope(503, "Storage unavailable", requestId));
    return true;
  }

  const config = deps.config ?? defaultOffloadConfig();
  // Normalize trailing slash for consistent route matching
  const normalizedPath = pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
  const route = `${method} ${normalizedPath}`;

  switch (route) {
    case "POST /v2/offload/ingest":
      await handleIngest(req, res, auth, {
        storage,
        stateBackend: deps.stateBackend,
        config,
        logger: deps.logger,
      }, requestId, parseJsonBody, sendJson, successEnvelope, errorEnvelope);
      return true;

    case "POST /v2/offload/query-mmd": {
      const body = await parseJsonBody<{ session_id?: string; limit?: number }>(req);
      const parsed = MmdQuerySchema.safeParse(body);
      if (!parsed.success) {
        sendJson(res, 400, errorEnvelope(400, "missing or invalid session_id in body", requestId));
        return true;
      }
      await handleMmdQuery(req, res, auth, storage, requestId, sendJson, successEnvelope, errorEnvelope, parsed.data.session_id, parsed.data.limit);
      return true;
    }

    case "POST /v2/offload/compact":
      // Compaction receives the full message history + per-message token
      // array, so it gets its own body limit instead of the 1 MiB default.
      await handleCompaction(req, res, auth, {
        storage,
        config,
        logger: deps.logger,
      }, requestId, (r) => parseJsonBody(r, OFFLOAD_MAX_BODY_BYTES), sendJson, successEnvelope, errorEnvelope);
      return true;

    default:
      return false;
  }
}
