import { sha256 } from './hash.js';
import { Outbox } from './outbox.js';

export const ADAPTER_VERSION = 'kiro-memory-phase1';

export class CaptureServiceError extends Error {
  constructor(message) { super(message); this.name = 'CaptureServiceError'; }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonicalize = (value) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  throw new CaptureServiceError('Invalid capture payload');
};

const isTrace = (trace) => isObject(trace)
  && typeof trace.tool_call_id === 'string' && typeof trace.tool_name === 'string'
  && isObject(trace.tool_call) && isObject(trace.tool_result)
  && trace.tool_call.role === 'tool_call' && trace.tool_result.role === 'tool_result'
  && trace.tool_call.tool_call_id === trace.tool_call_id && trace.tool_result.tool_call_id === trace.tool_call_id
  && trace.tool_call.tool_name === trace.tool_name && trace.tool_result.tool_name === trace.tool_name
  && typeof trace.tool_call.content === 'string' && typeof trace.tool_result.content === 'string';

export function buildSkillConversationPayload(turn, config) {
  if (!isObject(turn) || turn.lifecycle_status !== 'completed' || turn.assistant_observation?.available !== false || turn.assistant_observation?.content !== null || !Array.isArray(turn.tool_events) || turn.tool_events.length === 0 || typeof turn.session_id !== 'string' || typeof turn.turn_id !== 'string' || typeof turn.prompt !== 'string' || !turn.tool_events.every(isTrace)) {
    throw new CaptureServiceError('Turn is not eligible for observed capture');
  }
  if (!isObject(config) || !['teamId', 'userId', 'agentId'].every((key) => typeof config[key] === 'string' && config[key].length > 0)) throw new CaptureServiceError('Capture configuration is invalid');
  const messages = [{ role: 'user', content: turn.prompt }];
  for (const trace of turn.tool_events) messages.push(trace.tool_call, trace.tool_result);
  return { session_id: turn.session_id, team_id: config.teamId, user_id: config.userId, agent_id: config.agentId, task_id: turn.turn_id, messages };
}

export function createCaptureId({ adapterVersion = ADAPTER_VERSION, sessionId, turnId, payload } = {}) {
  if (typeof adapterVersion !== 'string' || typeof sessionId !== 'string' || typeof turnId !== 'string') throw new CaptureServiceError('Capture id input is invalid');
  const input = canonicalize({ adapter_version: adapterVersion, capture_type: 'skill_conversation', session_id: sessionId, turn_id: turnId, payload });
  return `cap_sha256_${sha256(JSON.stringify(input))}`;
}

export class CaptureService {
  constructor({ config, gatewayClient, outbox, now, adapterVersion = ADAPTER_VERSION } = {}) {
    if (!isObject(config)) throw new CaptureServiceError('Capture configuration is invalid');
    this.config = config;
    this.adapterVersion = adapterVersion;
    this.outbox = outbox ?? new Outbox({ stateDir: config.stateDir, gatewayClient, now });
  }

  async captureObservedToolTrace(turn) {
    const payload = buildSkillConversationPayload(turn, this.config);
    const captureId = createCaptureId({ adapterVersion: this.adapterVersion, sessionId: turn.session_id, turnId: turn.turn_id, payload });
    const envelope = { capture_id: captureId, type: 'skill_conversation', session_id: turn.session_id, turn_id: turn.turn_id, payload };
    const existingMarker = await this.outbox.hasMarker(captureId);
    await this.outbox.enqueue(envelope);
    if (!existingMarker) await this.outbox.flush({ maxItems: 3, budgetMs: 1_500 });
    return { captureStatus: await this.outbox.hasMarker(captureId) ? 'partial_captured' : 'retry_pending', captureId };
  }

  async captureFullTurn() { throw new CaptureServiceError('Full turn capture is unsupported'); }
}
