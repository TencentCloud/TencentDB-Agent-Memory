const knownEventNames = new Set(['UserPromptSubmit', 'PostToolUse', 'Stop']);

export class HookEventValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HookEventValidationError';
  }
}

export function normalizeHookEvent(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HookEventValidationError('Invalid hook event: raw');
  }

  const eventName = knownEventNames.has(raw.hook_event_name)
    ? raw.hook_event_name
    : 'Unknown';

  if (eventName !== 'Unknown' && (typeof raw.session_id !== 'string' || raw.session_id.length === 0)) {
    throw new HookEventValidationError(`Invalid ${eventName} hook event: session_id`);
  }

  if (eventName === 'UserPromptSubmit' && typeof raw.prompt !== 'string') {
    throw new HookEventValidationError('Invalid UserPromptSubmit hook event: prompt');
  }

  const normalized = {
    eventName,
    sessionId: raw.session_id,
  };

  if (raw.cwd !== undefined) normalized.cwd = raw.cwd;
  if (raw.prompt !== undefined) normalized.prompt = raw.prompt;
  if (raw.tool_name !== undefined) normalized.toolName = raw.tool_name;
  if (raw.tool_input !== undefined) normalized.toolInput = raw.tool_input;
  if (raw.tool_response !== undefined) normalized.toolResponse = raw.tool_response;
  if (typeof raw.assistant_response === 'string') normalized.assistantResponse = raw.assistant_response;

  normalized.raw = raw;
  return normalized;
}
