import type { Plugin } from "@opencode-ai/plugin";

import { createPlugin } from "./plugin.js";

export const TencentDBAgentMemory: Plugin = createPlugin;

export { TdaiMemoryClient, TdaiClientError } from "./client.js";
export { loadConfig } from "./config.js";
