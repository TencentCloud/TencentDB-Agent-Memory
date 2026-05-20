#!/usr/bin/env node
import { hookAdditionalContext, readHookInput, recallForPrompt } from "./lib.mjs";

const payload = await readHookInput();
const context = await recallForPrompt(payload, "", "session-start");
process.stdout.write(hookAdditionalContext("SessionStart", context));
