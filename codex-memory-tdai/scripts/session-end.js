#!/usr/bin/env node
/**
 * Codex SessionEnd hook: flush pending memory for the session via the
 * Gateway's /session/end (a gap the original hooks left open).
 * Fails silently (no output, exit 0) so session teardown is never blocked.
 */

import { TdaiGatewayClient, runSessionEndHook } from "../vendor/tdai-sdk/index.js";
import { adapter } from "../adapter.js";

await runSessionEndHook(adapter, new TdaiGatewayClient());
process.exit(0);
