import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { inspectSessionLock, writeJsonAtomically, withSessionLock } from '../src/core/atomic-file.js';
import { sha256 } from '../src/core/hash.js';
import { TurnStore, TurnStoreError } from '../src/core/turn-store.js';

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
      version: 2,
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

test('rejects an oversized prompt before writing a turn file or active pointer', async () => {
  await withStateDir(async (stateDir) => {
    const store = new TurnStore({ stateDir, idFactory: () => 'turn-1' });
    const oversizedPrompt = 'p'.repeat(128 * 1024);

    await assert.rejects(
      store.createTurn({ sessionId: 'session-1', prompt: oversizedPrompt }),
      (error) => error instanceof TurnStoreError && error.message === 'turn state exceeds byte limit',
    );
    assert.equal(await store.getActiveTurn('session-1'), null);
    await assert.rejects(readFile(store.turnPath('session-1', 'turn-1'), 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(store.activePath('session-1'), 'utf8'), { code: 'ENOENT' });
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

test('serializes concurrent append capacity checks and persists only turns within 128KiB', async () => {
  await withStateDir(async (stateDir) => {
    const store = new TurnStore({ stateDir, idFactory: () => 'turn-1' });
    await store.createTurn({ sessionId: 'session-1', prompt: 'append' });
    const writes = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) => store.appendToolEvent('session-1', {
        id: index,
        content: 'e'.repeat(32 * 1024),
      })),
    );
    const turn = await store.getActiveTurn('session-1');

    assert.equal(writes.some((result) => result.status === 'rejected'), true);
    assert.equal(Buffer.byteLength(`${JSON.stringify(turn)}\n`, 'utf8') <= 128 * 1024, true);
  });
});

test('leaves an existing oversized turn file unchanged when completeTurn cannot write it', async () => {
  await withStateDir(async (stateDir) => {
    const store = new TurnStore({ stateDir, idFactory: () => 'turn-1' });
    const turn = await store.createTurn({ sessionId: 'session-1', prompt: 'valid' });
    const turnPath = store.turnPath('session-1', turn.turn_id);
    const stored = JSON.parse(await readFile(turnPath, 'utf8'));
    stored.prompt = 'p'.repeat(128 * 1024);
    stored.prompt_hash = `sha256:${sha256(stored.prompt)}`;
    const before = `${JSON.stringify(stored)}\n`;
    await writeFile(turnPath, before, 'utf8');

    await assert.rejects(
      store.completeTurn('session-1'),
      (error) => error instanceof TurnStoreError && error.message === 'turn state exceeds byte limit',
    );
    assert.equal(await readFile(turnPath, 'utf8'), before);
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

    const updated = await store.markCaptureStatus('session-1', first.turn_id, 'partial_captured', 'capture-1');

    assert.equal(updated.capture_status, 'partial_captured');
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
      store.markCaptureStatus('session-1', 'missing-turn', 'retry_pending'),
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

test('serializes same-session mutations across TurnStore instances and preserves a newer active turn', async () => {
  await withStateDir(async (stateDir) => {
    const storeA = new TurnStore({ stateDir, idFactory: () => 'turn-old' });
    const storeB = new TurnStore({ stateDir, idFactory: () => 'turn-new' });
    await storeA.createTurn({ sessionId: 'session-1', prompt: 'old' });
    const lockPath = join(stateDir, 'sessions', sha256('session-1'), '.turn-state.lock');
    let releaseLock;
    let enteredLock;
    const entered = new Promise((resolve) => { enteredLock = resolve; });
    const holdLock = withSessionLock(lockPath, async () => {
      enteredLock();
      await new Promise((resolve) => { releaseLock = resolve; });
    });
    await entered;

    const createNew = storeB.createTurn({ sessionId: 'session-1', prompt: 'new' });
    releaseLock();
    const newer = await createNew;
    const cleared = await storeA.clearActiveTurn('session-1', 'turn-old');
    await holdLock;

    assert.equal(cleared, false);
    assert.equal((await storeA.getActiveTurn('session-1')).turn_id, newer.turn_id);
  });
});

test('session locks publish a strict v2 owner lease and refresh its heartbeat', async () => {
  await withStateDir(async (stateDir) => {
    const lockPath = join(stateDir, '.lease.lock');
    let enterLock;
    let releaseLock;
    const entered = new Promise((resolve) => { enterLock = resolve; });
    const heldLock = withSessionLock(lockPath, async () => {
      enterLock();
      await new Promise((resolve) => { releaseLock = resolve; });
    }, {
      timeoutMs: 200,
      retryMs: 5,
      staleAfterMs: 100,
      heartbeatMs: 10,
      currentHostname: 'test-host',
    });
    await entered;
    const first = JSON.parse(await readFile(join(lockPath, 'owner'), 'utf8'));
    assert.deepEqual(Object.keys(first).sort(), [
      'created_at', 'heartbeat_at', 'hostname', 'owner_token', 'pid', 'version',
    ]);
    assert.equal(first.version, 2);
    assert.equal(first.hostname, 'test-host');
    assert.equal(first.pid, process.pid);
    assert.equal(typeof first.owner_token, 'string');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const refreshed = JSON.parse(await readFile(join(lockPath, 'owner'), 'utf8'));
    assert.equal(Date.parse(refreshed.heartbeat_at) > Date.parse(first.heartbeat_at), true);
    releaseLock();
    await heldLock;
    await assert.rejects(readFile(join(lockPath, 'owner'), 'utf8'), { code: 'ENOENT' });
  });
});

test('only an expired same-host owner with a dead pid is reclaimable', async () => {
  await withStateDir(async (stateDir) => {
    const lockPath = join(stateDir, '.inspect.lock');
    await mkdir(lockPath);
    const owner = {
      version: 2,
      owner_token: 'owner-token',
      pid: 12345,
      hostname: 'test-host',
      created_at: '2026-08-14T08:00:00.000Z',
      heartbeat_at: '2026-08-14T08:00:01.000Z',
    };
    await writeFile(join(lockPath, 'owner'), `${JSON.stringify(owner)}\n`);
    const options = {
      staleAfterMs: 1_000,
      nowMs: () => Date.parse('2026-08-14T08:01:00.000Z'),
      currentHostname: 'test-host',
    };
    assert.deepEqual(await inspectSessionLock(lockPath, {
      ...options, getProcessState: () => 'dead',
    }), { status: 'stale_reclaimable' });
    assert.deepEqual(await inspectSessionLock(lockPath, {
      ...options, getProcessState: () => 'alive',
    }), { status: 'active' });
    assert.deepEqual(await inspectSessionLock(lockPath, {
      ...options, getProcessState: () => 'unknown',
    }), { status: 'stale_unverified' });
    assert.deepEqual(await inspectSessionLock(lockPath, {
      ...options, currentHostname: 'other-host', getProcessState: () => 'dead',
    }), { status: 'stale_unverified' });
    await writeFile(join(lockPath, 'owner'), `${JSON.stringify({
      owner_token: 'legacy', pid: 12345, created_at: owner.created_at,
    })}\n`);
    assert.deepEqual(await inspectSessionLock(lockPath, options), { status: 'invalid' });
  });
});

test('times out without entering when an occupied lock has an old timestamp', async () => {
  await withStateDir(async (stateDir) => {
    const lockPath = join(stateDir, '.turn-state.lock');
    let releaseLock;
    let enterLock;
    const entered = new Promise((resolve) => { enterLock = resolve; });
    const heldLock = withSessionLock(lockPath, async () => {
      enterLock();
      await new Promise((resolve) => { releaseLock = resolve; });
    }, { timeoutMs: 200, retryMs: 5 });
    await entered;
    const oldTime = new Date(Date.now() - 120_000);
    await utimes(lockPath, oldTime, oldTime);

    let enteredSecond = false;
    await assert.rejects(withSessionLock(lockPath, async () => { enteredSecond = true; }, {
      timeoutMs: 50,
      retryMs: 5,
    }), /timed out/);
    assert.equal(enteredSecond, false);

    releaseLock();
    await heldLock;
  });
});

test('does not release an occupied lock when its owner token no longer matches', async () => {
  await withStateDir(async (stateDir) => {
    const lockPath = join(stateDir, '.turn-state.lock');
    let releaseLock;
    let enterLock;
    const entered = new Promise((resolve) => { enterLock = resolve; });
    const heldLock = withSessionLock(lockPath, async () => {
      enterLock();
      await new Promise((resolve) => { releaseLock = resolve; });
    }, { timeoutMs: 200, retryMs: 5 });
    await entered;
    await writeFile(join(lockPath, 'owner'), `${JSON.stringify({
      owner_token: 'replacement-owner',
      pid: 12345,
      created_at: '2026-08-14T08:00:00.000Z',
    })}\n`, 'utf8');

    releaseLock();
    await heldLock;
    let enteredSecond = false;
    await assert.rejects(withSessionLock(lockPath, async () => { enteredSecond = true; }, {
      timeoutMs: 50,
      retryMs: 5,
    }), /timed out/);
    assert.equal(enteredSecond, false);
    await rm(lockPath, { recursive: true, force: true });
  });
});

test('rejects invalid cwd and capture fields before state is written', async () => {
  await withStateDir(async (stateDir) => {
    const store = new TurnStore({ stateDir, idFactory: () => 'turn-1' });

    await assert.rejects(
      store.createTurn({ sessionId: 'session-1', cwd: null, prompt: 'valid' }),
      /cwd/,
    );
    await store.createTurn({ sessionId: 'session-1', prompt: 'valid' });
    await assert.rejects(
      store.markCaptureStatus('session-1', 'turn-1', 'INVALID'),
      /capture_status/,
    );
    await assert.rejects(
      store.markCaptureStatus('session-1', 'turn-1', 'full_captured', 1),
      /capture_id/,
    );
    const active = await store.getActiveTurn('session-1');
    assert.equal(active.capture_status, 'not_started');
    assert.equal(active.capture_id, null);
  });
});

test('rejects invalid lifecycle timestamp relationships in stored turns', async () => {
  await withStateDir(async (stateDir) => {
    const store = new TurnStore({ stateDir, idFactory: () => 'turn-1' });
    await store.createTurn({ sessionId: 'session-1', prompt: 'valid' });
    const turnPath = join(
      stateDir,
      'sessions',
      sha256('session-1'),
      'turns',
      'turn-1.json',
    );
    const state = JSON.parse(await readFile(turnPath, 'utf8'));
    state.completed_at = '2026-08-14T08:00:00.000Z';
    await writeFile(turnPath, `${JSON.stringify(state)}\n`, 'utf8');
    await assert.rejects(store.getActiveTurn('session-1'), /turn_id/);

    state.lifecycle_status = 'completed';
    state.completed_at = null;
    await writeFile(turnPath, `${JSON.stringify(state)}\n`, 'utf8');
    await assert.rejects(store.getActiveTurn('session-1'), /turn_id/);
  });
});

test('atomically replaces larger JSON files while concurrent readers see only complete JSON', async () => {
  await withStateDir(async (stateDir) => {
    const targetPath = join(stateDir, 'state.json');
    const allowedRevisions = new Set([0, 1, 2, 3, 4, 5]);
    await writeJsonAtomically(targetPath, { revision: 0, body: 'a'.repeat(256 * 1024) });
    const reader = (async () => {
      for (let readCount = 0; readCount < 100; readCount += 1) {
        const state = JSON.parse(await readFile(targetPath, 'utf8'));
        assert.equal(allowedRevisions.has(state.revision), true);
        assert.equal(state.body.length, 256 * 1024);
        assert.equal(state.body[0], state.revision === 0 ? 'a' : String(state.revision));
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    const writer = (async () => {
      for (let revision = 1; revision <= 5; revision += 1) {
        await writeJsonAtomically(targetPath, {
          revision,
          body: String(revision).repeat(256 * 1024),
        });
      }
    })();

    await Promise.all([writer, reader]);
  });
});
