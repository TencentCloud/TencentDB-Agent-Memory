import { describe, expect, it } from 'vitest';
import { ALLOWED_PANEL_ACTIONS } from '../src/panel/api/meta-actions';

const POOL_ACTIONS = [
  'subscription-pool/status',
  'subscription-pool/enable',
  'subscription-pool/disable',
  'subscription-pool/settings/update',
  'subscription-pool/account/oauth-start',
  'subscription-pool/account/oauth-complete',
  'subscription-pool/account/update',
  'subscription-pool/account/delete',
  'subscription-pool/account/check-usage',
  'subscription-pool/check-all',
];

describe('subscription pool panel actions', () => {
  it.each(POOL_ACTIONS)('allows %s through the meta proxy', (action) => {
    expect(ALLOWED_PANEL_ACTIONS.has(action as never)).toBe(true);
  });

  it('does not expose the internal pool endpoints', () => {
    expect(ALLOWED_PANEL_ACTIONS.has('subscription-pool/accounts/list' as never)).toBe(false);
    expect(ALLOWED_PANEL_ACTIONS.has('subscription-pool/report' as never)).toBe(false);
    expect(ALLOWED_PANEL_ACTIONS.has('subscription-pool/refresh' as never)).toBe(false);
  });
});
