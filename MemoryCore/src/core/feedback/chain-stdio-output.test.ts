/** New stream termination boundaries; no provider or old study replay. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { BRIDGE_LIMITS, runBridgeCli } from './chain-stdio-bridge.js';

const scope = { teamId: 'stream-team', userId: 'stream-user', agentId: 'stream-agent', taskId: '' };
const frame = (id: string, operation = 'snapshot') => JSON.stringify({ id, operation, args: {} }) + '\n';
function fixture(t: { after: (fn: () => void) => void }, deadlineMs = 100) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-stream-boundary-'));
  t.after(() => {
    const owned = resolve(dir); const parent = resolve(tmpdir());
    assert.ok(owned.startsWith(parent + sep) && owned !== parent);
    rmSync(owned, { recursive: true, force: true });
  });
  return ['--isolated', '--db', join(dir, 'isolated.sqlite'), '--scope', JSON.stringify(scope),
    '--deadline-ms', String(deadlineMs)];
}
function released(output: Writable) {
  assert.equal(output.listenerCount('error'), 0);
  assert.equal(output.listenerCount('close'), 0);
  assert.equal(output.listenerCount('drain'), 0);
}

test('stream deadline interrupts a never-completing output and stops subsequent frames', { timeout: 3000 }, async t => {
  const argv = fixture(t); let writes = 0; let firstWriteAt = 0;
  const output = new Writable({ highWaterMark: 1, write() { writes++; firstWriteAt ||= performance.now(); } });
  const input = Readable.from([frame('FIRST') + frame('SECOND')]);
  assert.equal(await runBridgeCli(argv, input, output), 1);
  assert.equal(writes, 1);
  assert.ok(performance.now() - firstWriteAt < 800, 'run deadline must interrupt the outstanding write');
  assert.equal(input.destroyed, true); assert.equal(output.destroyed, true); released(output);
});

test('serial writes preserve frame order when the output drains before the deadline', { timeout: 3000 }, async t => {
  const argv = fixture(t, 1000); const frames: string[] = [];
  const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
    frames.push(chunk.toString()); setTimeout(callback, 5);
  } });
  assert.equal(await runBridgeCli(argv, Readable.from([frame('FIRST') + frame('LAST', 'shutdown')]), output), 0);
  assert.deepEqual(frames.map(line => JSON.parse(line).id), ['FIRST', 'LAST']);
  assert.ok(frames.every(line => JSON.parse(line).status === 'pass'));
  assert.equal(output.destroyed, false); released(output); output.destroy();
});

test('an output close interrupts its pending write without an error-frame resend', { timeout: 3000 }, async t => {
  const argv = fixture(t, 1000); let writes = 0;
  const output = new Writable({ highWaterMark: 1, write() { writes++; setImmediate(() => output.destroy()); } });
  const input = Readable.from([frame('FIRST') + frame('SECOND')]);
  assert.equal(await runBridgeCli(argv, input, output), 1);
  assert.equal(writes, 1); assert.equal(input.destroyed, true); released(output);
});

test('asynchronous output callback errors are handled even below the high water mark', { timeout: 3000 }, async t => {
  const argv = fixture(t, 1000); let writes = 0;
  const output = new Writable({ highWaterMark: 65536, write(_chunk, _encoding, callback) {
    writes++; setImmediate(() => callback(new Error('private sink failure')));
  } });
  assert.equal(await runBridgeCli(argv, Readable.from([frame('FIRST') + frame('SECOND')]), output), 1);
  assert.equal(writes, 1); assert.equal(output.destroyed, true); released(output);
});

test('startup-error reporting has its own output bound when no run timer exists', { timeout: 3000 }, async () => {
  const frames: string[] = []; const started = performance.now();
  const output = new Writable({ highWaterMark: 1, write(chunk) { frames.push(chunk.toString()); } });
  assert.equal(await runBridgeCli([], Readable.from([]), output), 1);
  assert.equal(frames.length, 1); assert.equal(JSON.parse(frames[0]).code, 'isolated_flag_required');
  assert.ok(performance.now() - started < BRIDGE_LIMITS.outputWriteMs + 800);
  assert.equal(output.destroyed, true); released(output);
});

test('idle-input deadline returns failure when its single error report also blocks', { timeout: 3000 }, async t => {
  const argv = fixture(t); const frames: string[] = [];
  const input = new Readable({ read() {} });
  const output = new Writable({ highWaterMark: 1, write(chunk) { frames.push(chunk.toString()); } });
  assert.equal(await runBridgeCli(argv, input, output), 1);
  assert.equal(frames.length, 1); assert.equal(JSON.parse(frames[0]).code, 'deadline_exceeded');
  assert.equal(input.destroyed, true); assert.equal(output.destroyed, true); released(output);
});
