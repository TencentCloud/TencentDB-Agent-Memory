import { describe, expect, it } from 'vitest';
import { extractIdFields, extractServiceId, isValidIdSegment } from './api-helpers.js';

describe('knowledge tenant and filesystem identifiers', () => {
  it.each([undefined, null, 1, {}, '', ' ', '..', '../team', 'a/b', 'a\\b',
    'a.b', 'a\u0000b', 'x'.repeat(201)])('rejects invalid identifier %j', (value) => {
    expect(isValidIdSegment(value)).toBe(false);
  });

  it('accepts the inclusive length limit and ASCII identifier alphabet', () => {
    expect(isValidIdSegment('x'.repeat(200))).toBe(true);
    expect(extractServiceId('Service_123-A')).toBe('Service_123-A');
  });

  it('only takes the tenant from the header, ignoring a conflicting body tenant', () => {
    const body = { service_id: 'forged-tenant', team_id: 'team', user_id: 'user', agent_id: 'agent', task_id: 'task' };
    expect(extractIdFields('trusted-tenant', body)).toEqual({
      service_id: 'trusted-tenant', team_id: 'team', user_id: 'user', agent_id: 'agent', task_id: 'task',
    });
    expect(extractIdFields(undefined, body)).toBeNull();
    expect(extractIdFields('tenant', { team_id: '../other' })).toBeNull();
  });

  it('omits absent, empty or incorrectly typed optional metadata', () => {
    expect(extractIdFields('tenant', { team_id: 'team', user_id: '', agent_id: 3, task_id: null }))
      .toEqual({ service_id: 'tenant', team_id: 'team' });
  });
});
