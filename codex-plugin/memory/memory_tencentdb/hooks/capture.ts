import { runCaptureHook } from "../../../../src/adapters/adapter-sdk/index.js";
import { codexMemoryAdapter } from "../adapter.js";

await runCaptureHook(codexMemoryAdapter);
