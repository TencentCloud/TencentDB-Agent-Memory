import type { Event } from './standard.js';

export function normalize(raw: Record<string, unknown>): Event {
  return {
    version: 1, event: raw.hook_event_name, session_id: raw.session_id,
    turn_id: raw.turn_id, prompt: raw.prompt, reply: raw.last_assistant_message,
    stop_active: raw.stop_hook_active ?? false,
  };
}

export function encode(context: string, event: Event): object {
  return context ? { hookSpecificOutput: {
    hookEventName: event.event, additionalContext: context,
  } } : {};
}
