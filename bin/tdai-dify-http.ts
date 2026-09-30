#!/usr/bin/env node
/**
 * Dify HTTP server entry point.
 * All configuration via TDAI_* env vars — see bin/shared-http.ts for the complete list.
 *
 * Example Dify Plugin manifest (tools/memory.yaml):
 *   http_request_node:
 *     url: http://127.0.0.1:8420/recall
 *     method: POST
 *     headers:
 *       Authorization: "Bearer ${TDAI_GATEWAY_API_KEY}"
 */

import { DifyHttpServer } from "../src/adapters/dify/index.js";
import { loadHttpEnvOptions } from "./shared-http.js";

new DifyHttpServer(loadHttpEnvOptions("dify", 8420)).start().catch((err: unknown) => {
  process.stderr.write(
    `[tdai-dify-http] Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
