import { describe, expect, it } from 'vitest';
import { newExternalAssetId } from '../../src/panel/domain/asset-id.js';

describe('newExternalAssetId', () => {
  const prefixes: Array<[Parameters<typeof newExternalAssetId>[0], string]> = [
    ['skill', 'skl'],
    ['llm_wiki', 'wiki'],
    ['code_graph', 'cg'],
    ['chat_memory', 'mem'],
  ];

  it.each(prefixes)('%s → "%s-" prefix', (type, prefix) => {
    const id = newExternalAssetId(type);
    expect(id.startsWith(`${prefix}-`)).toBe(true);
  });

  it('produces 12 lowercase alphanumeric chars after the prefix', () => {
    for (const [type] of prefixes) {
      const id = newExternalAssetId(type);
      const suffix = id.split('-')[1];
      expect(suffix).toMatch(/^[a-z0-9]{12}$/);
    }
  });

  it('is unique across consecutive calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(newExternalAssetId('skill'));
    expect(seen.size).toBe(100);
  });
});
