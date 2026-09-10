import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DiagnosticService } from '../src/core/diagnostic-service.js';
import { GatewayClient } from '../src/core/gateway-client.js';
import { healthProject } from '../scripts/health.mjs';
import { validateState } from '../scripts/doctor.mjs';

test('diagnostic facts are bounded, content-free, and shared with gateway health', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-diagnostics-'));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', version: '0.2.0', storage: { enabled: true, requested: 'cos', effective: 'cos', degraded: false } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await writeFile(join(stateDir, 'state.json'), '{"version":2,"adapter":"kiro-memory","created_at":"2026-08-16T00:00:00.000Z"}\n');
    await mkdir(join(stateDir, 'outbox', '.locks'), { recursive: true });
    await mkdir(join(stateDir, 'captured'), { recursive: true });
    await mkdir(join(stateDir, 'sessions', 'hash', 'turns'), { recursive: true });
    await writeFile(join(stateDir, 'outbox', `op_sha256_${'a'.repeat(64)}.json`), '{}');
    await writeFile(join(stateDir, 'outbox', '.locks', 'x.lock'), 'private lock');
    await writeFile(join(stateDir, 'captured', `op_sha256_${'b'.repeat(64)}.json`), '{}');
    await writeFile(join(stateDir, 'sessions', 'hash', 'turns', 'turn.json'), '{bad');
    const config = { gatewayUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 500, serviceId: 'private-service', stateDir };
    const service = new DiagnosticService({ config, provenance: { gatewayUrl: 'environment', stateDir: 'default' }, gatewayClient: new GatewayClient(config) });
    const status = await service.getStatus({ includeGateway: true });
    assert.equal(status.status, 'degraded');
    assert.equal(status.gateway, 'reachable');
    assert.equal(status.state_version, 2);
    assert.equal(status.outbox_pending, 1);
    assert.equal(status.turns, 1);
    assert.equal(status.markers, 1);
    assert.equal(status.locks, 1);
    assert.equal(JSON.stringify(status).includes('private-service'), false);
    assert.equal(JSON.stringify(status).includes('private lock'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('health project returns the same fixed schema and invalid config never exposes values', async () => {
  const project = await mkdtemp(join(tmpdir(), 'kiro-health-'));
  try {
    await assert.rejects(
      healthProject({ project, env: { TDAI_MEMORY_GATEWAY_URL: 'private-invalid-value' } }),
      (error) => !error.message.includes('private-invalid-value'),
    );
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('doctor state validation is offline and rejects future manifests or inconsistent migration journals', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-doctor-state-'));
  try {
    await validateState(stateDir);
    await writeFile(join(stateDir, 'state.json'), '{"version":3}\n');
    await assert.rejects(validateState(stateDir), /state/);

    await writeFile(join(stateDir, 'state.json'), '{"version":2,"adapter":"kiro-memory","created_at":"2026-08-16T00:00:00.000Z"}\n');
    await mkdir(join(stateDir, '.migration', 'v1-to-v2'), { recursive: true });
    await writeFile(join(stateDir, '.migration', 'v1-to-v2', 'plan.json'), '{"version":1,"migration":"v1-to-v2","objects":[]}\n');
    await writeFile(join(stateDir, '.migration', 'v1-to-v2', 'progress.json'), '{"version":1,"next_index":1}\n');
    await assert.rejects(validateState(stateDir), /journal/);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
