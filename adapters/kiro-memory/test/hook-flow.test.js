import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { KiroIdeHookAssistantProvider } from '../src/core/assistant-response-provider.js';
import { TURN_MAX_BYTES } from '../src/core/sanitize.js';
import { TurnStore } from '../src/core/turn-store.js';
import { handlePostToolUse } from '../src/hooks/post-tool-use.js';
import { handlePromptSubmit } from '../src/hooks/prompt-submit.js';
import { handleStop } from '../src/hooks/stop.js';

const withStateDir = async (run) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-hook-flow-'));
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
};

const promptEvent = (sessionId = 'session-1') => ({
  eventName: 'UserPromptSubmit', sessionId, cwd: 'C:/demo', prompt: 'remember this',
});
const toolEvent = (sessionId = 'session-1', toolInput = { path: 'notes.txt' }, toolResponse = 'result') => ({
  eventName: 'PostToolUse', sessionId, toolName: 'read', toolInput, toolResponse,
});
const stopEvent = (sessionId = 'session-1') => ({ eventName: 'Stop', sessionId });

test('assistant provider always returns null without using an event response or tool result', async () => {
  const provider = new KiroIdeHookAssistantProvider();
  assert.equal(await provider.getAssistantResponse({ assistantResponse: 'must-not-use', toolResponse: 'also-not-use' }, {}), null);
});

test('Prompt Submit flush failure still creates a real turn and recalls context', async () => {
  await withStateDir(async (stateDir) => {
    const store = new TurnStore({ stateDir, idFactory: () => 'turn-1' });
    let recalledPrompt;
    const result = await handlePromptSubmit(promptEvent(), {
      turnStore: store,
      flushOutbox: async () => { throw new Error('flush'); },
      recallService: { recall: async (prompt) => { recalledPrompt = prompt; return 'recalled'; } },
    });
    assert.deepEqual(result, { exitCode: 0, stdout: 'recalled', status: 'turn_created', turnId: 'turn-1' });
    assert.equal(recalledPrompt, 'remember this');
    assert.equal((await store.getActiveTurn('session-1')).turn_id, 'turn-1');
  });
});

test('Prompt Submit state and recall errors fail open without leaking prompt content', async () => {
  const secret = 'prompt-sensitive-value';
  let recalled = false;
  const result = await handlePromptSubmit({ ...promptEvent(), prompt: secret }, {
    turnStore: { createTurn: async () => { throw new Error('state'); } },
    recallService: { recall: async () => { recalled = true; throw new Error('recall'); } },
  });
  assert.deepEqual(result, { exitCode: 0, stdout: '', status: 'state_error' });
  assert.equal(recalled, true);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('Prompt Submit fails open for an oversized prompt while still recalling', async () => {
  await withStateDir(async (stateDir) => {
    const store = new TurnStore({ stateDir, idFactory: () => 'turn-1' });
    let recalled = false;
    const result = await handlePromptSubmit({ ...promptEvent(), prompt: 'p'.repeat(128 * 1024) }, {
      turnStore: store,
      recallService: { recall: async () => { recalled = true; return 'context'; } },
    });

    assert.deepEqual(result, { exitCode: 0, stdout: 'context', status: 'state_error' });
    assert.equal(recalled, true);
    assert.equal(await store.getActiveTurn('session-1'), null);
  });
});

test('PostToolUse appends a sanitized trace to the real active turn with matching IDs', async () => {
  await withStateDir(async (stateDir) => {
    const store = new TurnStore({ stateDir, idFactory: () => 'turn-1' });
    await store.createTurn({ sessionId: 'session-1', prompt: 'read' });
    const result = await handlePostToolUse(toolEvent('session-1', { token: 'tool-secret', path: 'notes.txt' }), {
      turnStore: store, toolCallIdFactory: () => 'call-1',
    });
    const turn = await store.getActiveTurn('session-1');
    const [trace] = turn.tool_events;
    assert.deepEqual(result, { exitCode: 0, stdout: '', status: 'tool_trace_appended', turnId: 'turn-1' });
    assert.equal(trace.tool_call_id, 'kiro-turn-1-call-1');
    assert.equal(trace.tool_call.tool_call_id, trace.tool_result.tool_call_id);
    assert.equal(trace.tool_call.content.includes('tool-secret'), false);
    assert.equal(trace.tool_call.content.includes('<REDACTED>'), true);
  });
});

test('PostToolUse does not create a turn for an orphan tool event', async () => {
  await withStateDir(async (stateDir) => {
    const store = new TurnStore({ stateDir });
    const result = await handlePostToolUse(toolEvent(), { turnStore: store, toolCallIdFactory: () => 'call-1' });
    assert.deepEqual(result, { exitCode: 0, stdout: '', status: 'orphan_tool_event' });
    assert.equal(await store.getActiveTurn('session-1'), null);
  });
});

test('PostToolUse uses distinct factory values for two same-session traces and rejects unsafe IDs', async () => {
  await withStateDir(async (stateDir) => {
    const store = new TurnStore({ stateDir, idFactory: () => 'turn-1' });
    await store.createTurn({ sessionId: 'session-1', prompt: 'read' });
    let next = 0;
    await handlePostToolUse(toolEvent(), { turnStore: store, toolCallIdFactory: () => `call-${++next}` });
    await handlePostToolUse(toolEvent(), { turnStore: store, toolCallIdFactory: () => `call-${++next}` });
    const turn = await store.getActiveTurn('session-1');
    assert.equal(new Set(turn.tool_events.map((item) => item.tool_call_id)).size, 2);
    const unsafe = await handlePostToolUse(toolEvent(), { turnStore: store, toolCallIdFactory: () => 'bad id' });
    assert.deepEqual(unsafe, { exitCode: 0, stdout: '', status: 'tool_trace_error' });
    assert.equal((await store.getActiveTurn('session-1')).tool_events.length, 2);
  });
});

test('PostToolUse truncates oversized input and result before persistence', async () => {
  await withStateDir(async (stateDir) => {
    const store = new TurnStore({ stateDir, idFactory: () => 'turn-1' });
    await store.createTurn({ sessionId: 'session-1', prompt: 'read' });
    await handlePostToolUse(toolEvent('session-1', 'x'.repeat(9000), 'y'.repeat(34000)), {
      turnStore: store, toolCallIdFactory: () => 'long',
    });
    const [trace] = (await store.getActiveTurn('session-1')).tool_events;
    assert.equal(Buffer.byteLength(trace.tool_call.content, 'utf8') <= 8 * 1024, true);
    assert.equal(Buffer.byteLength(trace.tool_result.content, 'utf8') <= 32 * 1024, true);
    assert.equal(trace.tool_call.content.includes('<TRUNCATED original_bytes=9000>'), true);
    assert.equal(trace.tool_result.content.includes('<TRUNCATED original_bytes=34000>'), true);
  });
});

test('PostToolUse rejects the first trace that would exceed the persisted turn byte budget', async () => {
  await withStateDir(async (stateDir) => {
    const store = new TurnStore({ stateDir, idFactory: () => 'turn-1' });
    await store.createTurn({ sessionId: 'session-1', prompt: 'read' });
    let calls = 0;
    let successful = 0;
    let exceeded = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await handlePostToolUse(
        toolEvent('session-1', 'i'.repeat(8 * 1024), 'r'.repeat(32 * 1024)),
        { turnStore: store, toolCallIdFactory: () => `budget-${++calls}` },
      );
      if (result.status === 'tool_trace_error') {
        exceeded = true;
        break;
      }
      assert.equal(result.status, 'tool_trace_appended');
      successful += 1;
    }
    const turn = await store.getActiveTurn('session-1');
    assert.equal(exceeded, true);
    assert.equal(successful > 0, true);
    assert.equal(turn.tool_events.length, successful);
    assert.equal(Buffer.byteLength(`${JSON.stringify(turn)}\n`, 'utf8') <= TURN_MAX_BYTES, true);
  });
});

test('PostToolUse reports concurrent over-capacity appends without exceeding the real turn budget', async () => {
  await withStateDir(async (stateDir) => {
    const store = new TurnStore({ stateDir, idFactory: () => 'turn-1' });
    await store.createTurn({ sessionId: 'session-1', prompt: 'read' });
    const results = await Promise.all(Array.from({ length: 4 }, (_, index) => handlePostToolUse(
      toolEvent('session-1', 'i'.repeat(8 * 1024), 'r'.repeat(32 * 1024)),
      { turnStore: store, toolCallIdFactory: () => `concurrent-${index}` },
    )));
    const turn = await store.getActiveTurn('session-1');

    assert.equal(results.some((result) => result.status === 'tool_trace_error'), true);
    assert.equal(turn.tool_events.length, results.filter((result) => result.status === 'tool_trace_appended').length);
    assert.equal(Buffer.byteLength(`${JSON.stringify(turn)}\n`, 'utf8') <= TURN_MAX_BYTES, true);
  });
});

test('Stop with no active turn is an idempotent NOOP', async () => {
  await withStateDir(async (stateDir) => {
    const store = new TurnStore({ stateDir });
    const result = await handleStop(stopEvent(), {
      turnStore: store, assistantResponseProvider: new KiroIdeHookAssistantProvider(), captureService: {},
    });
    assert.deepEqual(result, { exitCode: 0, stdout: '', status: 'duplicate_or_unmatched_stop' });
  });
});

test('Stop without observable data marks skipped and clears the real active pointer', async () => {
  await withStateDir(async (stateDir) => {
    const store = new TurnStore({ stateDir, idFactory: () => 'turn-1' });
    await store.createTurn({ sessionId: 'session-1', prompt: 'stop' });
    const result = await handleStop(stopEvent(), {
      turnStore: store, assistantResponseProvider: new KiroIdeHookAssistantProvider(), captureService: {},
    });
    assert.deepEqual(result, { exitCode: 0, stdout: '', status: 'skipped_no_observable_data', turnId: 'turn-1' });
    assert.equal(await store.getActiveTurn('session-1'), null);
  });
});

test('Stop with a tool trace captures observed data, marks it, and does not call full capture', async () => {
  await withStateDir(async (stateDir) => {
    const store = new TurnStore({ stateDir, idFactory: () => 'turn-1' });
    await store.createTurn({ sessionId: 'session-1', prompt: 'stop' });
    await handlePostToolUse(toolEvent(), { turnStore: store, toolCallIdFactory: () => 'call-1' });
    let fullCaptureCalled = false;
    const result = await handleStop(stopEvent(), {
      turnStore: store,
      assistantResponseProvider: new KiroIdeHookAssistantProvider(),
      captureService: {
        captureObservedToolTrace: async () => ({ captureStatus: 'partial_capture_pending', captureId: 'capture-1' }),
        captureFullTurn: async () => { fullCaptureCalled = true; },
      },
    });
    assert.deepEqual(result, { exitCode: 0, stdout: '', status: 'partial_capture_pending', turnId: 'turn-1', captureId: 'capture-1' });
    assert.equal(fullCaptureCalled, false);
    assert.equal(await store.getActiveTurn('session-1'), null);
  });
});

test('Stop leaves the active pointer available for retry when capture, mark, or clear fails', async () => {
  for (const failure of ['capture', 'mark', 'clear']) {
    await withStateDir(async (stateDir) => {
      const realStore = new TurnStore({ stateDir, idFactory: () => 'turn-1' });
      await realStore.createTurn({ sessionId: 'session-1', prompt: 'stop' });
      await handlePostToolUse(toolEvent(), { turnStore: realStore, toolCallIdFactory: () => 'call-1' });
      const store = Object.create(realStore);
      if (failure === 'mark') store.markCaptureStatus = async () => { throw new Error('mark'); };
      if (failure === 'clear') store.clearActiveTurn = async () => false;
      const result = await handleStop(stopEvent(), {
        turnStore: store,
        assistantResponseProvider: new KiroIdeHookAssistantProvider(),
        captureService: { captureObservedToolTrace: async () => {
          if (failure === 'capture') throw new Error('capture');
          return { captureStatus: 'partial_captured', captureId: 'capture-1' };
        } },
      });
      assert.deepEqual(result, { exitCode: 0, stdout: '', status: 'finalize_error' });
      assert.equal((await realStore.getActiveTurn('session-1')).turn_id, 'turn-1');
    });
  }
});

test('Stop provider failure is fail-open and keeps the real active pointer', async () => {
  await withStateDir(async (stateDir) => {
    const store = new TurnStore({ stateDir, idFactory: () => 'turn-1' });
    await store.createTurn({ sessionId: 'session-1', prompt: 'stop' });
    const result = await handleStop(stopEvent(), {
      turnStore: store,
      assistantResponseProvider: { getAssistantResponse: async () => { throw new Error('provider'); } },
      captureService: {},
    });
    assert.deepEqual(result, { exitCode: 0, stdout: '', status: 'finalize_error' });
    assert.equal((await store.getActiveTurn('session-1')).turn_id, 'turn-1');
  });
});

test('a retried Stop finalizes the same turn without creating another one', async () => {
  await withStateDir(async (stateDir) => {
    let turnIds = 0;
    const store = new TurnStore({ stateDir, idFactory: () => `turn-${++turnIds}` });
    await store.createTurn({ sessionId: 'session-1', prompt: 'stop' });
    await handlePostToolUse(toolEvent(), { turnStore: store, toolCallIdFactory: () => 'call-1' });
    let attempts = 0;
    const dependencies = {
      turnStore: store,
      assistantResponseProvider: new KiroIdeHookAssistantProvider(),
      captureService: { captureObservedToolTrace: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient');
        return { captureStatus: 'partial_captured', captureId: 'capture-1' };
      } },
    };
    assert.equal((await handleStop(stopEvent(), dependencies)).status, 'finalize_error');
    const retried = await handleStop(stopEvent(), dependencies);
    assert.equal(retried.status, 'partial_captured');
    assert.equal(retried.turnId, 'turn-1');
    assert.equal(turnIds, 1);
    assert.equal(await store.getActiveTurn('session-1'), null);
  });
});

test('invalid events are fail-open and do not expose event content', async () => {
  const secret = 'sensitive-event-value';
  const dependencies = { turnStore: {}, recallService: {} };
  const result = await handlePromptSubmit({ eventName: 'Stop', prompt: secret }, dependencies);
  assert.deepEqual(result, { exitCode: 0, stdout: '', status: 'invalid_event' });
  assert.equal(JSON.stringify(result).includes(secret), false);
});
