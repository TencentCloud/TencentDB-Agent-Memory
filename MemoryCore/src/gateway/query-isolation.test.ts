import { describe, expect, it } from 'vitest';
import { optionalQueryUserId } from './query-isolation.js';

describe('optionalQueryUserId', () => {
  it('does not turn a missing user_id into the default isolation bucket filter', () => {
    expect(optionalQueryUserId({}, 'default')).toBeUndefined();
  });

  it('preserves an explicitly requested user_id filter', () => {
    expect(optionalQueryUserId({ user_id: 'openclaw' }, 'openclaw')).toBe('openclaw');
  });
});