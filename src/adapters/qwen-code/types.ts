export type QwenCodeHookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "Stop"
  | "SessionEnd"
  | string;

export interface QwenCodeHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: QwenCodeHookEventName;
  timestamp: string;
  prompt?: string;
  last_assistant_message?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface QwenCodeHookOutput {
  continue?: boolean;
  decision?: "allow" | "block" | "deny" | "ask" | "approve";
  reason?: string;
  systemMessage?: string;
  hookSpecificOutput?: Record<string, unknown>;
}

export interface QwenCodeCompletedTurn {
  userText: string;
  assistantText: string;
  sourceIds: string[];
}

export interface QwenCodeAdapterLogger {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface QwenCodeAdapterEnv {
  [key: string]: string | undefined;
}

