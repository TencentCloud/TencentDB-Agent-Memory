export type Event = {
  version: 1;
  event?: unknown;
  session_id?: unknown;
  turn_id?: unknown;
  prompt?: unknown;
  reply?: unknown;
  stop_active?: unknown;
};

export function normalize(raw: Record<string, unknown>): Event {
  if (raw.version !== 1) throw new Error('Expected protocol version 1');
  return raw as Event;
}

export function encode(context: string, _event: Event): object {
  return context ? { context } : {};
}
