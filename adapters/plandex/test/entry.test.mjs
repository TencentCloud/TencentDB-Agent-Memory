import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const runCli = (args, env = {}) =>
  spawnSync(process.execPath, ['tdai-plandex.mjs', ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 15000,
  });

describe('CLI entry point (real process smoke test)', () => {
  it('--version prints a semver and exits 0', () => {
    const result = runCli(['--version']);
    assert.equal(result.status, 0);
    assert.match(result.stdout.trim(), /^tdai-plandex \d+\.\d+\.\d+$/);
  });

  it('--help prints usage and exits 0', () => {
    const result = runCli(['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:/);
  });

  it('generate --dry-run emits parseable JSON through the real process', () => {
    const result = runCli(['generate', '--dry-run'], { TDAI_UPSTREAM_MODEL: 'gpt-5.5' });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).providers[0].name, 'tencentdb-agent-memory');
  });

  it('unknown commands exit 1 with a diagnostic', () => {
    const result = runCli(['frobnicate']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown command/i);
  });
});
