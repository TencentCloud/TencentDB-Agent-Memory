import { expect, it, vi } from 'vitest';
import { handleMemorySearch } from '../../../MemoryCore/openclaw-plugin/src/tools/memory-search.js';
import { handleConversationSearch } from '../../../MemoryCore/openclaw-plugin/src/tools/conversation-search.js';
import { handleReadCos } from '../../../MemoryCore/openclaw-plugin/src/tools/read-cos.js';

const canary = 'synthetic-private-canary';
for (const kind of ['memory', 'conversation', 'file'] as const) {
  it.each([false, true])(`${kind} preserves caller results but omits private data from logs (failure=%s)`, async failure => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const work = vi.fn(async () => {
      if (failure) throw new Error(canary);
      if (kind === 'file') return canary;
      if (kind === 'memory') return { items: [{ content: canary, type: 'synthetic' }] };
      return { messages: [{ content: canary, role: 'user' }] };
    });
    // Minimal synthetic stand-ins invoke the actual handlers, including error paths.
    const result = kind === 'memory' ? await handleMemorySearch({ searchAtomic: work } as never, { query: canary }, logger)
      : kind === 'conversation' ? await handleConversationSearch({ searchConversation: work } as never, { query: canary, session_key: canary }, logger)
      : await handleReadCos({ read: work } as never, { path: `${canary}.md` }, logger);
    expect(work).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).toContain(canary);
    expect(JSON.stringify([logger.debug.mock.calls, logger.warn.mock.calls])).not.toContain(canary);
    expect(failure ? logger.warn : logger.debug).toHaveBeenCalled();
  });
}

it('capture preserves session scoping and content without logging the session identifier', async () => {
  const { performCapture } = await import('../../../MemoryCore/openclaw-plugin/src/hooks/capture.js');
  const logger = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const addConversation = vi.fn(async () => ({ total_count: 1 }));
  const result = await performCapture({ addConversation } as never, {
    sessionKey: canary, rawMessages: [{ role: 'user', content: 'synthetic private message', timestamp: 1000 }],
  }, logger);
  expect(addConversation).toHaveBeenCalledWith({ session_id: canary, messages: [{ role: 'user', content: 'synthetic private message', timestamp: '1970-01-01T00:00:01.000Z' }] });
  expect(result).toMatchObject({ capturedCount: 1, serverTotalCount: 1, maxTimestamp: 1000 });
  const logs = JSON.stringify([logger.debug.mock.calls, logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
  expect(logs).not.toContain(canary);
  expect(logs).not.toContain('synthetic private message');
  expect(logger.info).toHaveBeenCalled();
});
