import { expect, it, vi } from 'vitest';
const fakes = vi.hoisted(() => ({ recall: vi.fn(), capture: vi.fn(), isolation: vi.fn() }));
vi.mock('@tencentdb-agent-memory/memory-sdk-ts-v2', () => ({
  MemoryClient: class { withIsolation(scope: unknown) { fakes.isolation(scope); return this; } },
  createMemoryFileReader: () => ({}),
}));
vi.mock('../../../MemoryCore/openclaw-plugin/src/hooks/recall.js', () => ({ performRecall: fakes.recall }));
vi.mock('../../../MemoryCore/openclaw-plugin/src/hooks/capture.js', () => ({ performCapture: fakes.capture }));
import register from '../../../MemoryCore/openclaw-plugin/index.js';

it.each([false, true])('registered OpenClaw hooks omit private config/session/error values (failure=%s)', async failure => {
  vi.clearAllMocks();
  const canary = 'synthetic-private-canary';
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  fakes.recall.mockImplementation(async () => {
    if (failure) throw new Error(canary);
    return { prependContext: canary };
  });
  fakes.capture.mockImplementation(async () => {
    if (failure) throw new Error(canary);
    return { capturedCount: 1, serverTotalCount: 1, maxTimestamp: 1000 };
  });
  register({
    pluginConfig: { server: { url: `https://${canary}.invalid`, apiKey: canary, instanceId: canary, teamId: canary, agentId: canary, userId: canary } },
    logger, registerTool: vi.fn(), on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, handler),
  });
  const ctx = { sessionKey: canary, sessionId: canary };
  const recalled = await handlers.get('before_prompt_build')!({ prompt: canary, messages: [] }, ctx);
  expect(recalled).toEqual(failure ? undefined : { prependContext: canary });
  await handlers.get('agent_end')!({ success: true, messages: [{ role: 'user', content: canary }] }, ctx);
  expect(fakes.recall).toHaveBeenCalledOnce();
  expect(fakes.capture).toHaveBeenCalledOnce();
  expect(fakes.recall.mock.calls[0][1].query).toBe(canary);
  expect(fakes.capture.mock.calls[0][1]).toMatchObject({ sessionKey: canary, sessionId: canary, originalUserText: canary });
  expect(fakes.isolation).toHaveBeenCalledTimes(2);
  expect(fakes.isolation).toHaveBeenCalledWith({ sessionId: canary });
  expect(JSON.stringify([logger.info.mock.calls, logger.debug.mock.calls, logger.warn.mock.calls, logger.error.mock.calls])).not.toContain(canary);
  if (failure) expect(logger.warn).toHaveBeenCalledTimes(2);
});
