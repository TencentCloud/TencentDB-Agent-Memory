import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sanitizeToolContent,
  TOOL_INPUT_MAX_BYTES,
  TOOL_RESULT_MAX_BYTES,
  TURN_MAX_BYTES,
} from '../src/core/sanitize.js';

test('sanitizes nested sensitive keys without mutating the input and sorts JSON keys', () => {
  const input = {
    zebra: 1,
    nested: { Token: 'nested-secret', alpha: 2 },
    api_key: 'top-secret',
    alpha: 3,
  };
  const before = structuredClone(input);

  const sanitized = sanitizeToolContent(input, TOOL_INPUT_MAX_BYTES);

  assert.equal(
    sanitized,
    '{"alpha":3,"api_key":"<REDACTED>","nested":{"Token":"<REDACTED>","alpha":2},"zebra":1}',
  );
  assert.deepEqual(input, before);
});

test('sanitizes bearer, environment-style secrets, key-value secrets, and private-key blocks in strings', () => {
  const secret = 'actual-sensitive-value';
  const sanitized = sanitizeToolContent(
    `Bearer ${secret}\nOPENAI_API_KEY=${secret}\npassword: first-half second-half\n-----BEGIN PRIVATE KEY-----\nplain-secret\n-----END PRIVATE KEY-----\n-----BEGIN RSA PRIVATE KEY-----\n${secret}\n-----END RSA PRIVATE KEY-----`,
    TOOL_INPUT_MAX_BYTES,
  );

  assert.equal(sanitized.includes(secret), false);
  assert.equal(sanitized.includes('plain-secret'), false);
  assert.equal(sanitized.includes('first-half'), false);
  assert.equal(sanitized.includes('second-half'), false);
  assert.equal(sanitized.includes('<REDACTED>'), true);
});

test('serializes undefined as null and uses an opaque placeholder for circular and bigint values', () => {
  const circular = {};
  circular.self = circular;

  assert.equal(sanitizeToolContent(undefined, TOOL_INPUT_MAX_BYTES), 'null');
  assert.equal(sanitizeToolContent(circular, TOOL_INPUT_MAX_BYTES), '<UNSERIALIZABLE>');
  assert.equal(sanitizeToolContent({ value: 1n }, TOOL_INPUT_MAX_BYTES), '<UNSERIALIZABLE>');
});

test('applies the UTF-8 budget to unserializable markers without exposing input', () => {
  const circular = {};
  circular.self = circular;
  for (const value of [circular, { value: 1n }]) {
    assert.throws(
      () => sanitizeToolContent(value, 1),
      (error) => error instanceof Error && error.message === 'SanitizationError',
    );
  }
});

test('truncates at a UTF-8 boundary while retaining original byte count', () => {
  const source = '😀'.repeat(12);
  const maxBytes = 45;
  const sanitized = sanitizeToolContent(source, maxBytes);

  assert.equal(Buffer.byteLength(sanitized, 'utf8') <= maxBytes, true);
  assert.equal(sanitized.endsWith('<TRUNCATED original_bytes=48>'), true);
  assert.equal(sanitized.startsWith('😀'), true);
  assert.equal(Buffer.byteLength(sanitized, 'utf8') <= maxBytes, true);
});

test('rejects invalid byte limits with an opaque error', () => {
  for (const maxBytes of [0, -1, 1.5, Number.NaN, '8']) {
    assert.throws(
      () => sanitizeToolContent('safe', maxBytes),
      (error) => error instanceof Error && error.message === 'Invalid maxBytes',
    );
  }
  assert.equal(TOOL_INPUT_MAX_BYTES, 8 * 1024);
  assert.equal(TOOL_RESULT_MAX_BYTES, 32 * 1024);
  assert.equal(TURN_MAX_BYTES, 128 * 1024);
});

test('rejects truncation when a valid budget cannot contain the complete marker', () => {
  assert.throws(
    () => sanitizeToolContent('content requiring truncation', 1),
    (error) => error instanceof Error && error.message === 'SanitizationError',
  );
});
