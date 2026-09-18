import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { kiroCapabilities } from '../src/core/capability.js';
import {
  HookEventValidationError,
  normalizeHookEvent,
} from '../src/core/event-normalizer.js';

const fixture = async (name) => JSON.parse(
  await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
);

test('normalizes a UserPromptSubmit fixture', async () => {
  const raw = await fixture('prompt-submit');

  assert.deepEqual(normalizeHookEvent(raw), {
    eventName: 'UserPromptSubmit',
    sessionId: 'session-prompt-fixture',
    cwd: 'C:/workspace/demo',
    prompt: 'Summarize the current task.',
    raw,
  });
});

test('normalizes a PostToolUse fixture', async () => {
  const raw = await fixture('post-tool-use');
  const normalized = normalizeHookEvent(raw);

  assert.equal(normalized.eventName, 'PostToolUse');
  assert.equal(normalized.sessionId, 'session-tool-fixture');
  assert.equal(normalized.cwd, 'C:/workspace/demo');
  assert.equal(normalized.toolName, 'readFile');
  assert.deepEqual(normalized.toolInput, { path: 'notes.txt' });
  assert.deepEqual(normalized.toolResponse, { content: 'fixture content' });
  assert.equal(normalized.raw, raw);
});

test('normalizes a Stop fixture without an assistant response', async () => {
  const raw = await fixture('stop');
  const normalized = normalizeHookEvent(raw);

  assert.equal(normalized.eventName, 'Stop');
  assert.equal(normalized.sessionId, 'session-stop-fixture');
  assert.equal(normalized.cwd, 'C:/workspace/demo');
  assert.equal(normalized.assistantResponse, undefined);
  assert.equal(normalized.raw, raw);
});

test('exposes immutable Kiro IDE capabilities', () => {
  assert.deepEqual(kiroCapabilities, {
    platform: 'kiro-ide',
    prompt: true,
    session_id: true,
    post_tool_use: true,
    tool_input: true,
    tool_response: true,
    stop: true,
    assistant_response_on_stop: false,
  });
  assert.equal(Object.isFrozen(kiroCapabilities), true);
});

test('normalizes an unknown event without rejecting it', () => {
  const raw = { hook_event_name: 'Unrecognized', marker: 'unchanged' };

  assert.deepEqual(normalizeHookEvent(raw), {
    eventName: 'Unknown',
    sessionId: undefined,
    raw,
  });
});

test('rejects non-object hook input with a validation error', () => {
  assert.throws(
    () => normalizeHookEvent(['not-an-object']),
    HookEventValidationError,
  );
});

test('rejects known events without a non-empty session id', () => {
  assert.throws(
    () => normalizeHookEvent({ hook_event_name: 'Stop', session_id: '' }),
    HookEventValidationError,
  );
});

test('rejects UserPromptSubmit without a string prompt', () => {
  assert.throws(
    () => normalizeHookEvent({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-1',
    }),
    HookEventValidationError,
  );
});

test('does not include sensitive input values in validation errors', () => {
  const secret = 'sensitive-example-value';

  assert.throws(
    () => normalizeHookEvent({ hook_event_name: 'Stop', prompt: secret }),
    (error) => {
      assert.equal(error instanceof HookEventValidationError, true);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

test('does not modify the raw hook event', () => {
  const raw = {
    hook_event_name: 'PostToolUse',
    session_id: 'session-1',
    tool_input: { path: 'notes.txt' },
  };
  const before = structuredClone(raw);

  normalizeHookEvent(raw);

  assert.deepEqual(raw, before);
});
