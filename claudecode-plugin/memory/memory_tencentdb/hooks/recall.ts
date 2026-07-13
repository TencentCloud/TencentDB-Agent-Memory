import { runRecallHook } from "../../../../src/adapters/adapter-sdk/index.js";
import { claudeCodeMemoryAdapter } from "../adapter.js";

await runRecallHook(claudeCodeMemoryAdapter);
