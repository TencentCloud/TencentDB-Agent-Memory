import type { ClaudeCodeToolEvent, ToolCaptureDecision } from "../types.js";

const DEFAULT_CAPTURE_TOOL_PATTERNS = [
  /bash/i,
  /shell/i,
  /terminal/i,
  /edit/i,
  /write/i,
  /patch/i,
  /notebookedit/i,
];

const DEFAULT_SKIP_TOOL_PATTERNS = [
  /^read$/i,
  /^ls$/i,
  /glob/i,
  /grep/i,
  /search/i,
];

const LARGE_RESULT_CHARS = 4000;

export function shouldCaptureToolEvent(event: ClaudeCodeToolEvent): ToolCaptureDecision {
  if (event.status === "error") {
    return { capture: true, reason: "tool_error", writeRef: true };
  }

  const resultLength = event.resultSummary.length + JSON.stringify(event.rawResult ?? "").length;
  if (resultLength >= LARGE_RESULT_CHARS) {
    return { capture: true, reason: "large_result", writeRef: true };
  }

  if (DEFAULT_CAPTURE_TOOL_PATTERNS.some((pattern) => pattern.test(event.toolName))) {
    return { capture: true, reason: "high_signal_tool", writeRef: resultLength > 1000 };
  }

  if (DEFAULT_SKIP_TOOL_PATTERNS.some((pattern) => pattern.test(event.toolName))) {
    return { capture: false, reason: "low_signal_read_only_tool", writeRef: false };
  }

  return { capture: false, reason: "default_skip", writeRef: false };
}
