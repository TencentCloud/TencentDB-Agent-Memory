import type { PluginModule } from "@opencode-ai/plugin";
import { createPlugin } from "./plugin.js";

const plugin: PluginModule = { id: "tencentdb-agent-memory", server: createPlugin };
export default plugin;
