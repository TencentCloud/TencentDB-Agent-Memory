import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createRuntimeDependencies } from '../src/cli.js';
import { parseDrainArgs, runDrainCli } from '../scripts/drain.mjs';

test('drain arguments have bounded defaults and strict finite overrides', () => {
  assert.deepEqual(parseDrainArgs(['--project', '.']), {
    project: resolve('.'), options: { maxItems: 50, concurrency: 4, budgetMs: 30_000 },
  });
  assert.deepEqual(parseDrainArgs([
    '--budget-ms', '60000', '--project', '.', '--concurrency', '8', '--max-items', '100',
  ]).options, { maxItems: 100, concurrency: 8, budgetMs: 60_000 });
  for (const argv of [
    ['--project', '.', '--unknown', '1'],
    ['--project', '.', '--project', '.'],
    ['--project', '.', '--max-items', '0'],
    ['--project', '.', '--concurrency', '1.5'],
    ['--project', '.', '--budget-ms'],
  ]) assert.throws(() => parseDrainArgs(argv));
});

test('runDrainCli emits one safe JSON line or one fixed error line', async () => {
  const summary = { selected: 1, processed: 1, acknowledged: 1, failed: 0, deferred: 0, manualReview: 0, durationMs: 2, payload: 'must-not-print' };
  const safeSummary = { selected: 1, processed: 1, acknowledged: 1, failed: 0, deferred: 0, manualReview: 0, durationMs: 2 };
  const success = await runDrainCli({ argv: ['--project', '.'], drain: async () => summary });
  assert.deepEqual(success, { exitCode: 0, stdout: `${JSON.stringify(safeSummary)}\n`, stderr: '' });
  assert.equal(success.stdout.includes('must-not-print'), false);
  assert.equal(success.stdout.trim().split('\n').length, 1);
  const failure = await runDrainCli({ argv: ['--unknown', 'secret-value'] });
  assert.deepEqual(failure, { exitCode: 1, stdout: '', stderr: 'tdai-memory drain: failed\n' });
  assert.equal(failure.stderr.includes('secret-value'), false);
});

test('runtime dependency factory preserves force-archive acknowledgement wiring', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-drain-runtime-'));
  try {
    const dependencies = createRuntimeDependencies({
      stateDir, gatewayUrl: 'https://example.test', timeoutMs: 1000,
      serviceId: 'service', teamId: 'team', userId: 'user', agentId: 'agent',
    });
    let recorded;
    dependencies.archiveService.recordForceOutcome = async (input) => { recorded = input; };
    await dependencies.outbox.onAcknowledged({
      version: 2, operation_type: 'force_archive', session_id: 'session', archive_generation: 3,
    }, { status: 'empty' });
    assert.deepEqual(recorded, {
      sessionId: 'session', archiveGeneration: 3, response: { status: 'empty' },
    });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('direct drain process rejects unsafe arguments without echoing them', async () => {
  const script = fileURLToPath(new URL('../scripts/drain.mjs', import.meta.url));
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [script, '--unknown', 'secret-value'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (exitCode) => resolveResult({ exitCode, stdout, stderr }));
  });
  assert.deepEqual(result, { exitCode: 1, stdout: '', stderr: 'tdai-memory drain: failed\n' });
});
