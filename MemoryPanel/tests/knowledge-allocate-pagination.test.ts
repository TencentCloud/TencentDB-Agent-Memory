import { describe, expect, it, vi } from 'vitest';
import { fetchAllAgentFixedAssetBindings } from '../src/panel/http/routes/knowledge/common.js';

describe('fetchAllAgentFixedAssetBindings', () => {
  it('loads every page before a read-modify-write allocation', async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => ({ asset_id: `asset-${i}` }));
    const secondPage = Array.from({ length: 25 }, (_, i) => ({ asset_id: `asset-${i + 100}` }));
    const invoke = vi.fn()
      .mockResolvedValueOnce({ code: 0, data: { items: firstPage, total: 125 } })
      .mockResolvedValueOnce({ code: 0, data: { items: secondPage, total: 125 } });

    const result = await fetchAllAgentFixedAssetBindings(
      { metaKernel: { invoke } } as never,
      {} as never,
      'agent-1',
    );

    expect(result.error).toBeUndefined();
    expect(result.items).toHaveLength(125);
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      'agent-fixed-asset/list',
      { agent_id: 'agent-1', limit: 100, offset: 0 },
      {},
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'agent-fixed-asset/list',
      { agent_id: 'agent-1', limit: 100, offset: 100 },
      {},
    );
  });

  it('returns the upstream error without fabricating bindings', async () => {
    const error = { code: 502, message: 'upstream unavailable' };
    const invoke = vi.fn().mockResolvedValue(error);
    const result = await fetchAllAgentFixedAssetBindings(
      { metaKernel: { invoke } } as never,
      {} as never,
      'agent-1',
    );

    expect(result.items).toEqual([]);
    expect(result.error).toBe(error);
  });
});
