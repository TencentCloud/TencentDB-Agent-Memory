import { randomUUID } from 'node:crypto';

import { buildToolTrace } from '../core/tool-trace.js';

const validFactoryValue = (value) => typeof value === 'string'
  && value.length > 0
  && /^[A-Za-z0-9._-]+$/.test(value);

export async function handlePostToolUse(event, { turnStore, toolCallIdFactory = randomUUID } = {}) {
  const base = { exitCode: 0, stdout: '' };
  if (event?.eventName !== 'PostToolUse') return { ...base, status: 'invalid_event' };
  try {
    const turn = await turnStore.getActiveTurn(event.sessionId);
    if (turn === null) return { ...base, status: 'orphan_tool_event' };
    const factoryValue = toolCallIdFactory();
    if (!validFactoryValue(factoryValue)) throw new Error('tool_call_id');
    const trace = buildToolTrace({
      event,
      turn,
      toolCallId: `kiro-${turn.turn_id}-${factoryValue}`,
    });
    const updated = await turnStore.appendToolEvent(event.sessionId, trace);
    if (updated === null) throw new Error('append');
    return { ...base, status: 'tool_trace_appended', turnId: turn.turn_id };
  } catch {
    return { ...base, status: 'tool_trace_error' };
  }
}
