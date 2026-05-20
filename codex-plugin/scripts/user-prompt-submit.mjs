#!/usr/bin/env node
import { beginTurn, hookAdditionalContext, promptFromPayload, readHookInput, recallForPrompt } from "./lib.mjs";

const payload = await readHookInput();
const prompt = promptFromPayload(payload);
await beginTurn(payload);
const context = await recallForPrompt(payload, prompt, "prompt");
process.stdout.write(hookAdditionalContext("UserPromptSubmit", context));
