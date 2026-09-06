import { createMemoryTools, type MemoryTools } from "../mcp/tools.js";
import { ExternalAdapterOperationStore } from "../sdk/operation-store.js";
import { createAdapterRuntime } from "../sdk/runtime.js";
import { ClaudeCodePlatformAdapter } from "./adapter.js";

export interface ClaudeCodeUserPromptSubmitInput {
  hook_event_name: "UserPromptSubmit";
  session_id: string;
  prompt_id?: string;
  cwd: string;
  prompt: string;
}

export interface ClaudeCodeStopInput {
  hook_event_name: "Stop";
  session_id: string;
  prompt_id?: string;
  cwd: string;
  stop_hook_active: boolean;
  last_assistant_message: string | null;
  background_tasks?: unknown[];
  session_crons?: unknown[];
  /** Path of the session transcript JSONL; Claude Code sends it in every hook payload. */
  transcript_path?: string;
}

export interface ClaudeCodeSessionEndInput {
  hook_event_name: "SessionEnd";
  session_id: string;
  cwd: string;
  reason: string;
  /** Path of the session transcript JSONL; Claude Code sends it in every hook payload. */
  transcript_path?: string;
}

export type ClaudeCodeHookInput =
  | ClaudeCodeUserPromptSubmitInput
  | ClaudeCodeStopInput
  | ClaudeCodeSessionEndInput;

export type ClaudeCodeHookOutput = Record<string, unknown>;

export interface ClaudeCodeHookOptions {
  stateDir?: string;
  tools?: MemoryTools;
  log?: (message: string) => void;
  /** Claude Code config dir used to locate a transcript when the payload lacks `transcript_path`. */
  claudeConfigDir?: string;
}

export async function handleClaudeCodeHook(
  input: ClaudeCodeHookInput,
  options: ClaudeCodeHookOptions = {},
): Promise<ClaudeCodeHookOutput> {
  const tools = options.tools ?? createMemoryTools();
  const log = options.log ?? ((message: string) => process.stderr.write(`[memory-tencentdb][claude-code] ${message}\n`));
  const runtime = createAdapterRuntime({
    platform: "claude-code",
    client: tools,
    operationStore: new ExternalAdapterOperationStore(),
    log: (message) => log(message
      .replace("[claude-code] recall failed open:", "Gateway recall failed open:")
      .replace("[claude-code] capture failed open:", "Gateway capture failed open:")
      .replace("[claude-code] session end failed open:", "Gateway session end failed open:")),
  });
  return new ClaudeCodePlatformAdapter({
    stateDir: options.stateDir,
    claudeConfigDir: options.claudeConfigDir,
    transcriptClient: options.tools ?? createMemoryTools({ timeoutMs: transcriptTimeoutMs() }),
    log,
  }).create(runtime)(input);
}

const DEFAULT_TRANSCRIPT_TIMEOUT_MS = 15_000;

/** Gateway timeout for one transcript batch (`TDAI_CLAUDE_CODE_TRANSCRIPT_TIMEOUT_MS`, default 15000). */
function transcriptTimeoutMs(): number {
  const parsed = Number(process.env.TDAI_CLAUDE_CODE_TRANSCRIPT_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TRANSCRIPT_TIMEOUT_MS;
}