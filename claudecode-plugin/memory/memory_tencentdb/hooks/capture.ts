import { runCaptureHook } from "../../../../src/adapters/adapter-sdk/index.js";
import { claudeCodeMemoryAdapter } from "../adapter.js";

await runCaptureHook(claudeCodeMemoryAdapter);
