#!/usr/bin/env node
/**
 * Whale Stop hook: capture the finished user/assistant turn and send it to
 * the TdaiGateway for memory storage (fire-and-forget; failures never surface).
 * Whale's Stop payload carries last_assistant_text directly — no transcript read.
 */

import { TdaiGatewayClient, runCaptureHook } from "../vendor/tdai-sdk/index.js";
import { adapter } from "../adapter.js";

// 25s budget mirrors the original hook (hooks.toml allows 30s for Stop).
await runCaptureHook(adapter, new TdaiGatewayClient({ timeoutMs: 25000 }));
process.exit(0);
