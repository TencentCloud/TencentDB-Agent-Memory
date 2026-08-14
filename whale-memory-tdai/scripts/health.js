#!/usr/bin/env node
/**
 * Whale SessionStart hook: verify the TdaiGateway is reachable.
 * Fails silently (no output, exit 0) so session start is never blocked.
 */

import { TdaiGatewayClient, runHealthHook } from "../vendor/tdai-sdk/index.js";

await runHealthHook(new TdaiGatewayClient());
process.exit(0);
