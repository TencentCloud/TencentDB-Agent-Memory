import {
  sanitizeToolContent,
  TOOL_INPUT_MAX_BYTES,
  TOOL_RESULT_MAX_BYTES,
  TURN_MAX_BYTES,
} from './sanitize.js';

const invalid = () => {
  throw new Error('Tool trace failed');
};

export function buildToolTrace({ event, turn, toolCallId, observedAt }) {
  if (event?.eventName !== 'PostToolUse') invalid();
  if (typeof turn?.turn_id !== 'string' || turn.turn_id.length === 0) invalid();
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) invalid();
  if (typeof event.toolName !== 'string' || event.toolName.length === 0) invalid();
  if (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) invalid();

  const trace = {
    tool_call_id: toolCallId,
    tool_name: event.toolName,
    observed_at: observedAt,
    tool_call: {
      role: 'tool_call',
      tool_name: event.toolName,
      tool_call_id: toolCallId,
      content: sanitizeToolContent(event.toolInput, TOOL_INPUT_MAX_BYTES),
    },
    tool_result: {
      role: 'tool_result',
      tool_name: event.toolName,
      tool_call_id: toolCallId,
      content: sanitizeToolContent(event.toolResponse, TOOL_RESULT_MAX_BYTES),
    },
  };
  if (Buffer.byteLength(JSON.stringify(trace), 'utf8') > TURN_MAX_BYTES) invalid();
  return trace;
}
