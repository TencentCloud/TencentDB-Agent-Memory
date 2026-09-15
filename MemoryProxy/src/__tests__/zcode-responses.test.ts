import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../server.js';
import { DEFAULT_CONFIG } from '../config.js';
import { SessionStore } from '../session/store.js';
import { recordTdaiTurn } from '../tdai/recorder.js';
import { executeMemCommand } from '../mem-command/index.js';
import { injectCodexAssets } from '../codexHandler.js';
import type { InstanceUpstreamConfigEntry } from '../instance-upstream-cache.js';

const state = vi.hoisted(() => ({ store: null as SessionStore | null, configs: [] as InstanceUpstreamConfigEntry[] }));
vi.mock('../auth.js', () => ({ verifyUserKey: async () => ({ userId: 'u', rejected: false }) }));
vi.mock('../session/store.js', async original => ({ ...await original<typeof import('../session/store.js')>(), getSessionStore: () => state.store! }));
vi.mock('../instance-upstream-cache.js', async original => ({ ...await original<typeof import('../instance-upstream-cache.js')>(), getInstanceUpstreamConfigs: async () => state.configs }));
vi.mock('../meta/client.js', () => ({ getMetadataClient: () => ({
  listTeams: async () => [{ team_id: 'team-a', name: 'Team A' }, { team_id: 'team-b', name: 'Team B' }],
  listAgents: async () => [{ agent_id: 'agent-a', name: 'Agent A' }, { agent_id: 'agent-b', name: 'Agent B' }],
  listTasks: async () => [{ task_id: 'task-a', title: 'Task A' }],
  getAgent: async () => ({ agent_id: 'agent-a', name: 'Agent A' }),
  getTask: async () => ({ task_id: 'task-a', title: 'Task A' }),
}) }));
vi.mock('../tdai/capabilities.js', () => ({ fetchAssetCapabilities: async () => ({ chat_memory: true }) }));
vi.mock('../injection/index.js', () => ({
  tryActivateStorage: () => true, tryActivateRedis: () => true, prewarmFromConfig: async () => {},
  getInjectionPipeline: () => ({ process: async () => ({ messages: [{ role: 'system', content: '<user_memory>remembered</user_memory>' }] }) }),
}));
vi.mock('../tdai/recorder.js', () => ({ recordTdaiTurn: vi.fn(async () => {}) }));
vi.mock('../skill/handler-glue.js', () => ({ triggerSkillExtractIfReady: async () => {} }));
vi.mock('../mem-command/index.js', async original => ({ ...await original<typeof import('../mem-command/index.js')>(), executeMemCommand: vi.fn(async () => ({ success: true, messageText: 'synced' })) }));
vi.mock('../langfuse.js');

const config = {
  ...DEFAULT_CONFIG,
  sessionInit: { ...DEFAULT_CONFIG.sessionInit, enabled: true },
  upstream: { ...DEFAULT_CONFIG.upstream, url: 'https://global.test/v1', apiKey: 'global-key', agents: {
    zcode: { openai: { url: 'https://chat.test/v1', apiKey: 'chat-key' }, responses: { url: 'https://responses.test/v1', apiKey: 'responses-key' } },
  } },
  coreSkill: { ...DEFAULT_CONFIG.coreSkill, endpoint: '' },
  injection: { ...DEFAULT_CONFIG.injection, enabled: true, injectors: ['tdai-memory'] },
  extraction: { enabled: true, extractors: ['tdai-memory'] },
  tdai: { ...DEFAULT_CONFIG.tdai, enabled: true, endpoint: 'http://memory.test', memory: { ...DEFAULT_CONFIG.tdai.memory, enabled: true, writeL0: true } },
};
const reply = { id: 'resp_test', object: 'response', status: 'completed', output: [
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } };
const upstream = vi.fn();
beforeEach(() => {
  vi.clearAllMocks(); state.store = new SessionStore(); state.configs = [];
  upstream.mockImplementation(async (_url, init) => JSON.parse(init.body).stream
    ? new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'answer' })}\r\n\r\ndata: ${JSON.stringify({ type: 'response.completed', response: reply })}\r\n\r\n`, { headers: { 'content-type': 'text/event-stream' } })
    : Response.json(reply));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());
const request = (app: ReturnType<typeof createApp>, body: unknown, path = '/zcode/default/responses') => app.request(path, {
  method: 'POST', headers: { authorization: 'Bearer business-key', 'x-session-id': 'native-session', 'content-type': 'application/json' }, body: JSON.stringify(body),
});

it.each([false, true])('ZCode Responses round trip (stream=%s): native form, identity, injection, L0 and mem commands', async stream => {
  const app = createApp(config);
  const input: any[] = [{ role: 'user', content: 'hello' }];
  for (let step = 0; step < 6; step++) {
    const response = await request(app, { model: 'test', input, stream }, stream ? '/zcode/default/v1/responses' : undefined);
    expect(response.status).toBe(200);
    const raw = await response.text();
    const result = stream ? JSON.parse(raw.split('\n').find(line => line.startsWith('data: ') && line.includes('response.completed'))!.slice(6)).response : JSON.parse(raw);
    if (result.id === reply.id) break;
    const call = result.output[0];
    expect(call.name).toBe('AskUserQuestion');
    const args = JSON.parse(call.arguments);
    const answers = Object.fromEntries(args.questions.map((q: any) => [q.question, q.options.find((o: any) => o.label.includes('Task A'))?.label ?? q.options[0].label]));
    input.push(call, { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify({ answers }) });
  }
  expect(state.store!.get('zcode:native-session')?.sessionInfo).toMatchObject({ team_id: 'team-a', agent_id: 'agent-a', task_id: 'task-a' });
  expect(state.store!.get('codex:native-session')).toBeUndefined();
  expect(upstream).toHaveBeenCalledTimes(1);
  const [url, init] = upstream.mock.calls[0];
  expect(url).toBe('https://responses.test/v1/responses');
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer responses-key');
  const sent = JSON.parse(init.body);
  expect(sent.input[0]).toMatchObject({ role: 'developer', content: [{ type: 'input_text', text: expect.stringContaining('<user_memory>remembered') }] });
  expect(sent.input[1]).toMatchObject({ role: 'user', content: [{ type: 'input_text', text: 'hello' }] });
  await vi.waitFor(() => expect(recordTdaiTurn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sessionId: 'native-session', userKey: 'business-key' }), { role: 'user', content: 'hello' }, 'answer'));
  await request(app, { model: 'test', input: 'mem:sync', stream: false });
  expect(executeMemCommand).toHaveBeenCalledWith(expect.objectContaining({ command: 'sync' }), expect.objectContaining({ agentSource: 'zcode', upstreamApiKey: 'responses-key', upstreamUrl: 'https://responses.test/v1', upstreamProtocol: 'responses', apiKey: 'business-key' }));
  state.configs = [{ agent_source: 'zcode', type: 'conversation', mode: 'custom_unified', base_url: 'https://instance.test/v1', api_key: 'instance-key', model_id: 'instance-model' }];
  await request(app, { model: 'test', input: 'mem:create-task', stream: false });
  expect(executeMemCommand).toHaveBeenLastCalledWith(expect.objectContaining({ command: 'create-task' }), expect.objectContaining({ upstreamApiKey: 'instance-key', upstreamUrl: 'https://instance.test/v1', model: 'instance-model', apiKey: 'business-key' }));
  const reset = await request(app, { model: 'test', input: 'mem:session-reset', stream: false });
  expect((await reset.json()).output[0].name).toBe('AskUserQuestion');
  expect(state.store!.get('zcode:native-session')?.status).toBe('pending_asset_confirm');
});

it('compact bypasses session init and respects instance passthrough credentials', async () => {
  state.configs = [{ agent_source: 'zcode', type: 'conversation', mode: 'custom_passthrough', base_url: 'https://instance.test/v1', api_key: '', model_id: 'instance-model' }];
  const app = createApp(config);
  await request(app, { model: 'test', input: 'hello' }, '/zcode/default/v1/responses/compact');
  expect(state.store!.get('zcode:native-session')).toBeUndefined();
  const [url, init] = upstream.mock.calls[0];
  expect(url).toBe('https://instance.test/v1/responses/compact');
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer business-key');
  expect(JSON.parse(init.body).model).toBe('instance-model');
  expect(recordTdaiTurn).not.toHaveBeenCalled();
});

it('keeps Codex native forms and does not mutate a leading user message during injection', async () => {
  const app = createApp(config);
  const res = await app.request('/codex/default/responses', { method: 'POST', headers: { authorization: 'Bearer business-key', 'session-id': 'codex-session', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'test', input: [], stream: false }) });
  expect((await res.json()).output[0].name).toBe('request_user_input');
  const body = { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }] };
  const injected = injectCodexAssets(body, { raw: 'memory' });
  expect((injected.input as any[])[1]).toBe(body.input[0]);
  expect(body.input).toHaveLength(1);
});

it.each(['agent-passthrough', 'instance-unified'])('resolves %s without borrowing the global key', async mode => {
  const agents = { zcode: { responses: { url: 'https://responses.test/v1' } } };
  const app = createApp({ ...config, upstream: { ...config.upstream, agents }, sessionInit: { ...config.sessionInit, enabled: false } });
  if (mode === 'instance-unified') state.configs = [{ agent_source: 'zcode', type: 'conversation', mode: 'custom_unified', base_url: 'https://instance.test/v1', api_key: 'instance-key', model_id: 'instance-model' }];
  await request(app, { model: 'test', input: 'hello' });
  const [url, init] = upstream.mock.calls[0];
  expect(url).toBe(mode === 'instance-unified' ? 'https://instance.test/v1/responses' : 'https://responses.test/v1/responses');
  expect(new Headers(init.headers).get('authorization')).toBe(mode === 'instance-unified' ? 'Bearer instance-key' : 'Bearer business-key');
});
