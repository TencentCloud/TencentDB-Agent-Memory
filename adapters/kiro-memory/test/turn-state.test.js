import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { TurnStore } from '../src/core/turn-store.js';

const withStateDir = async (run) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-turn-state-'));
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
};

test('creates and retrieves a turn using a hashed session directory', async () => {
  await withStateDir(async (stateDir) => {
    const store = new TurnStore({
      stateDir,
      idFactory: () => 'turn-fixed',
      now: () => new Date('2026-08-14T08:00:00.000Z'),
    });
    const created = await store.createTurn({
      sessionId: 'session-example',
      cwd: 'E:\\project',
      prompt: '用户输入',
    });

    assert.deepEqual(created, {
      version: 1,
      turn_id: 'turn-fixed',
      session_id: 'session-example',
      cwd: 'E:\\project',
      prompt: '用户输入',
      created_at: '2026-08-14T08:00:00.000Z',
      completed_at: null,
      lifecycle_status: 'pending',
      capture_status: 'not_started',
      assistant_observation: { available: false, content: null },
      tool_events: [],
      prompt_hash: 'sha256:718ca035879536818589325966696c2a8e92e0f8132e8a7c8f947d14eeccabc7',
      capture_id: null,
    });

    const active = await store.getActiveTurn('session-example');
    assert.deepEqual(active, created);

    const sessionDirectory = join(
      stateDir,
      'sessions',
      '979cad1aaaddf4c1a903ded408615fa8c438a3bfeee95472a13f606a86aaeda3',
    );
    const storedTurn = JSON.parse(await readFile(join(sessionDirectory, 'turns', 'turn-fixed.json'), 'utf8'));
    assert.deepEqual(storedTurn, created);
    assert.deepEqual(
      JSON.parse(await readFile(join(sessionDirectory, 'active.json'), 'utf8')),
      { version: 1, session_id: 'session-example', active_turn_id: 'turn-fixed' },
    );
  });
});

test('creates unique turns for the same session', async () => {
  await withStateDir(async (stateDir) => {
    let next = 0;
    const store = new TurnStore({ stateDir, idFactory: () => `turn-${++next}` });

    const turns = await Promise.all([
      store.createTurn({ sessionId: 'session-1', prompt: 'one' }),
      store.createTurn({ sessionId: 'session-1', prompt: 'two' }),
      store.createTurn({ sessionId: 'session-1', prompt: 'three' }),
    ]);

    assert.deepEqual(turns.map((turn) => turn.session_id), ['session-1', 'session-1', 'session-1']);
    assert.equal(new Set(turns.map((turn) => turn.turn_id)).size, 3);
    assert.equal(Object.hasOwn(turns[0], 'cwd'), false);
  });
});

test('appends a cleaned tool event without changing its input', async () => {
  await withStateDir(async (stateDir) => {
    const store = new TurnStore({ stateDir, idFactory: () => 'turn-1' });
    const event = { name: 'readFile', input: { path: 'notes.txt' } };
    const before = structuredClone(event);
    await store.createTurn({ sessionId: 'session-1', prompt: 'read notes' });

    const updated = await store.appendToolEvent('session-1', event);

    assert.deepEqual(event, before);
    assert.deepEqual(updated.tool_events, [event]);
    assert.equal(await store.appendToolEvent('missing-session', event), null);
  });
});

test('completes a turn once and preserves the first completion time', async () => {
  await withStateDir(async (stateDir) => {
    let calls = 0;
    const store = new TurnStore({
      stateDir,
      idFactory: () => 'turn-1',
      now: () => new Date(`2026-08-14T08:00:0${calls++}.000Z`),
    });
    await store.createTurn({ sessionId: 'session-1', prompt: 'finish' });

    const completed = await store.completeTurn('session-1');
    const repeated = await store.completeTurn('session-1');

    assert.equal(completed.lifecycle_status, 'completed');
    assert.equal(completed.completed_at, '2026-08-14T08:00:01.000Z');
    assert.deepEqual(repeated, completed);
  });
});

test('protects active pointers from stale clear requests and supports duplicate Stop NOOPs', async () => {
  await withStateDir(async (stateDir) => {
    const store = new TurnStore({ stateDir, idFactory: () => 'turn-1' });
    await store.createTurn({ sessionId: 'session-1', prompt: 'stop' });

    assert.equal(await store.clearActiveTurn('session-1', 'older-turn'), false);
    assert.notEqual(await store.getActiveTurn('session-1'), null);
    assert.equal(await store.clearActiveTurn('session-1', 'turn-1'), true);
    assert.equal(await store.completeTurn('session-1'), null);
    assert.equal(await store.clearActiveTurn('session-1', 'turn-1'), false);
  });
});

test('marks capture status on a non-active turn', async () => {
  await withStateDir(async (stateDir) => {
    let next = 0;
    const store = new TurnStore({ stateDir, idFactory: () => `turn-${++next}` });
    const first = await store.createTurn({ sessionId: 'session-1', prompt: 'first' });
    await store.createTurn({ sessionId: 'session-1', prompt: 'second' });

    const updated = await store.markCaptureStatus('session-1', first.turn_id, 'captured', 'capture-1');

    assert.equal(updated.capture_status, 'captured');
    assert.equal(updated.capture_id, 'capture-1');
    assert.equal((await store.getActiveTurn('session-1')).turn_id, 'turn-2');
  });
});

test('keeps state files parseable while repeatedly atomically updating a turn', async () => {
  await withStateDir(async (stateDir) => {
    const store = new TurnStore({ stateDir, idFactory: () => 'turn-1' });
    const turn = await store.createTurn({ sessionId: 'session-1', prompt: 'atomic' });
    const sessionHash = '84097828fc31a8c8d29210df48901a85de7fd013f686b17be77d1be29cb7a98b';
    const turnPath = join(stateDir, 'sessions', sessionHash, 'turns', `${turn.turn_id}.json`);

    for (let index = 0; index < 12; index += 1) {
      await store.appendToolEvent('session-1', { index });
      const contents = await readFile(turnPath, 'utf8');
      assert.equal(contents.endsWith('\n'), true);
      assert.equal(JSON.parse(contents).tool_events.length, index + 1);
    }
  });
});

test('rejects invalid input and invalid stored turns without leaking sensitive examples', async () => {
  await withStateDir(async (stateDir) => {
    const secret = 'sensitive-example-value';
    const store = new TurnStore({ stateDir, idFactory: () => 'turn-1' });

    await assert.rejects(
      store.createTurn({ sessionId: '', prompt: secret }),
      (error) => error.message.includes(secret) === false,
    );
    await assert.rejects(
      store.createTurn({ sessionId: 'session-1', prompt: null }),
      /prompt/,
    );
    await store.createTurn({ sessionId: 'session-1', prompt: 'valid' });

    const sessionHash = '84097828fc31a8c8d29210df48901a85de7fd013f686b17be77d1be29cb7a98b';
    const activePath = join(stateDir, 'sessions', sessionHash, 'active.json');
    await rm(join(stateDir, 'sessions', sessionHash, 'turns', 'turn-1.json'));
    await assert.rejects(
      store.getActiveTurn('session-1'),
      (error) => error.message.includes(secret) === false && error.message.includes('session-1') === false,
    );
    await assert.rejects(
      store.markCaptureStatus('session-1', 'missing-turn', 'failed'),
      /turn_id/,
    );
    assert.equal(JSON.parse(await readFile(activePath, 'utf8')).active_turn_id, 'turn-1');
  });
});

test('rejects structurally invalid active pointers and turn files', async () => {
  await withStateDir(async (stateDir) => {
    const store = new TurnStore({ stateDir, idFactory: () => 'turn-1' });
    await store.createTurn({ sessionId: 'session-1', prompt: 'valid' });
    const sessionHash = '84097828fc31a8c8d29210df48901a85de7fd013f686b17be77d1be29cb7a98b';
    const activePath = join(stateDir, 'sessions', sessionHash, 'active.json');
    const turnPath = join(stateDir, 'sessions', sessionHash, 'turns', 'turn-1.json');

    await writeFile(activePath, '{"version":1,"active_turn_id":"turn-1"}\n', 'utf8');
    await assert.rejects(store.getActiveTurn('session-1'), /active\.json/);

    await writeFile(
      activePath,
      '{"version":1,"session_id":"session-1","active_turn_id":"turn-1"}\n',
      'utf8',
    );
    await writeFile(turnPath, '{"version":1,"turn_id":"turn-1","tool_events":[]}\n', 'utf8');
    await assert.rejects(store.getActiveTurn('session-1'), /turn_id/);
  });
});
