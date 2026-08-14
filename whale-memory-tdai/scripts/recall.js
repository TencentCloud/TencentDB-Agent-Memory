#!/usr/bin/env node
/**
 * Whale UserPromptSubmit hook: recall relevant memories from the TdaiGateway
 * and print { decision, additional_context } for Whale to inject.
 * Fails silently (no output, exit 0) so the user is never blocked.
 */

import { TdaiGatewayClient, runRecallHook } from "../vendor/tdai-sdk/index.js";
import { adapter } from "../adapter.js";

await runRecallHook(adapter, new TdaiGatewayClient());
process.exit(0);
