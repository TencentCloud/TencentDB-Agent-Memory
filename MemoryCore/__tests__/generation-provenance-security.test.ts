import { expect, it, vi } from 'vitest';
import { writeGenerationProvenanceBestEffort } from '../src/core/memory-generation-log/best-effort.js';

it.each(['log', 'sync-ref', 'async-ref'])('keeps %s failures best-effort without logging backend payloads', async failure => {
  const canary = 'synthetic-private-storage-payload';
  const logger = { warn: vi.fn() };
  const writeLog = vi.fn(async () => { if (failure === 'log') throw new Error(canary); });
  const writeRefs = vi.fn(() => {
    if (failure === 'sync-ref') throw new Error(canary);
    return Promise.reject(new Error(canary));
  });
  await expect(writeGenerationProvenanceBestEffort({ layer: 'l1', logger, writeLog, writeRefs })).resolves.toBeUndefined();
  expect(writeLog).toHaveBeenCalledOnce();
  expect(writeRefs).toHaveBeenCalledTimes(failure === 'log' ? 0 : 1);
  expect(logger.warn).toHaveBeenCalledOnce();
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(canary);
});
it.each([false, true])('preserves successful reference writes (async=%s)', async asyncRefs => {
  const order: string[] = [];
  const logger = { warn: vi.fn() };
  await writeGenerationProvenanceBestEffort({
    layer: 'l2', logger, writeLog: async () => { order.push('log'); },
    writeRefs: () => { order.push('refs'); return asyncRefs ? Promise.resolve() : undefined; },
  });
  expect(order).toEqual(['log', 'refs']);
  expect(logger.warn).not.toHaveBeenCalled();
});
