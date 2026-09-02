#!/usr/bin/env node
/**
 * Codex UserPromptSubmit hook: recall relevant memories from the TdaiGateway
 * and print hookSpecificOutput.additionalContext for Codex to inject.
 * Fails silently (no output, exit 0) so the prompt is never blocked.
 */

import { TdaiGatewayClient, runRecallHook } from "../vendor/tdai-sdk/index.js";
import { adapter } from "../adapter.js";

await runRecallHook(adapter, new TdaiGatewayClient());
process.exit(0);
