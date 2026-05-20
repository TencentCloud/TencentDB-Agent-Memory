#!/usr/bin/env node
import { appendToolEvent, hookAdditionalContext, readHookInput, toolMemoryHint } from "./lib.mjs";

const payload = await readHookInput();
await appendToolEvent(payload, "pre_tool_use");
process.stdout.write(hookAdditionalContext("PreToolUse", toolMemoryHint(payload)));
