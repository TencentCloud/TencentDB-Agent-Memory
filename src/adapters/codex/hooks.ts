import { createMemoryTools, type MemoryTools } from "../mcp/tools.js";
import { ExternalAdapterOperationStore } from "../sdk/operation-store.js";
import { createAdapterRuntime } from "../sdk/runtime.js";
import { CodexPlatformAdapter } from "./adapter.js";

export interface CodexUserPromptSubmitInput {
  hook_event_name: "UserPromptSubmit";
  session_id: string;
  turn_id: string;
  cwd: string;
  prompt: string;
}

export interface CodexStopInput {
  hook_event_name: "Stop";
  session_id: string;
  turn_id: string;
  cwd: string;
  stop_hook_active: boolean;
  last_assistant_message: string | null;
}

export type CodexHookInput = CodexUserPromptSubmitInput | CodexStopInput;

export type CodexHookOutput = Record<string, unknown>;

export interface CodexHookOptions {
  stateDir?: string;
  tools?: MemoryTools;
  log?: (message: string) => void;
}

export async function handleCodexHook(
  input: CodexHookInput,
  options: CodexHookOptions = {},
): Promise<CodexHookOutput> {
  const tools = options.tools ?? createMemoryTools();
  const log = options.log ?? ((message: string) => process.stderr.write(`[memory-tencentdb][codex] ${message}\n`));
  const runtime = createAdapterRuntime({
    platform: "codex",
    client: tools,
    operationStore: new ExternalAdapterOperationStore(),
    log: (message) => log(message
      .replace("[codex] recall failed open:", "Gateway recall failed open:")
      .replace("[codex] capture failed open:", "Gateway capture failed open:")),
  });
  return new CodexPlatformAdapter({ stateDir: options.stateDir }).create(runtime)(input);
}