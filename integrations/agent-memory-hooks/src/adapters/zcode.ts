import type { Event } from './standard.js';
export { encode } from './codex.js';

export function normalize(raw: Record<string, unknown>): Event {
  return {
    version: 1, event: raw.hookEventName || raw.hook_event_name,
    session_id: raw.sessionId || raw.session_id, turn_id: raw.turnId,
    prompt: raw.prompt, reply: raw.responseText || raw.last_assistant_message,
    stop_active: raw.stopHookActive ?? raw.stop_hook_active ?? false,
  };
}
