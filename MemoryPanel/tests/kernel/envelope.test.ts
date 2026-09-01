import { describe, expect, it } from 'vitest';
import { mapHttpStatusFromEnvelopeCode } from '../../src/panel/kernel/envelope.js';

describe('mapHttpStatusFromEnvelopeCode', () => {
  it('maps code 0 to 200', () => {
    expect(mapHttpStatusFromEnvelopeCode(0)).toBe(200);
  });

  it.each([
    [400, 400],
    [403, 403],
    [499, 499],
    [500, 500],
    [599, 599],
  ])('maps %i → %i', (code, expected) => {
    expect(mapHttpStatusFromEnvelopeCode(code)).toBe(expected);
  });

  it.each([
    [399, 502],
    [600, 502],
    [-1, 502],
    [3, 502],
  ])('maps non-0, non-4xx/5xx %i → 502', (code) => {
    expect(mapHttpStatusFromEnvelopeCode(code)).toBe(502);
  });
});
