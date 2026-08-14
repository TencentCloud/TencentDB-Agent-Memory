#!/usr/bin/env node
/**
 * Codex Stop hook: capture the last user/assistant turn from the transcript
 * JSONL and send it to the TdaiGateway (fire-and-forget; failures never surface).
 */

import { TdaiGatewayClient, runCaptureHook } from "../vendor/tdai-sdk/index.js";
import { adapter } from "../adapter.js";

// 25s budget mirrors the original hook (hooks.json allows 30s for Stop).
await runCaptureHook(adapter, new TdaiGatewayClient({ timeoutMs: 25000 }));
process.exit(0);
