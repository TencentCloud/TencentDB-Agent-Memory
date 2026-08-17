import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseArgs, run } from '../lib/cli.mjs';

const silent = { log() {}, error() {} };

describe('parseArgs', () => {
  it('defaults to help', () => {
    assert.deepEqual(parseArgs([]), {
      command: 'help',
      options: { dryRun: false, probe: false, force: false, output: null },
    });
  });

  it('maps aliases and flags', () => {
    assert.equal(parseArgs(['generate']).command, 'generate');
    assert.equal(parseArgs(['init']).command, 'generate');
    assert.equal(parseArgs(['doctor']).command, 'check');
    assert.equal(parseArgs(['check', '--probe']).options.probe, true);
    assert.equal(parseArgs(['generate', '--force']).options.force, true);
    const parsed = parseArgs(['generate', '--dry-run', '--output', 'x.json']);
    assert.equal(parsed.options.dryRun, true);
    assert.equal(parsed.options.output, 'x.json');
  });

  it('flags unknown commands', () => {
    assert.match(parseArgs(['frobnicate']).error, /unknown command/i);
  });
});

describe('run generate', () => {
  it('prints valid JSON to stdout', async () => {
    let out = '';
    const code = await run(['generate', '--dry-run'], {
      env: { TDAI_UPSTREAM_MODEL: 'gpt-5.5' },
      stdout: { log: (s) => (out += `${s}\n`), error() {} },
      stderr: silent,
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.equal(parsed.$schema, 'https://plandex.ai/schemas/models-input.schema.json');
    assert.equal(parsed.providers[0].name, 'tencentdb-agent-memory');
  });

  it('fails without an upstream model and names the missing variable', async () => {
    let err = '';
    const code = await run(['generate'], {
      env: {},
      stdout: silent,
      stderr: { log: (s) => (err += s), error: (s) => (err += s) },
    });
    assert.equal(code, 1);
    assert.match(err, /TDAI_UPSTREAM_MODEL/);
  });

  it('writes a file, refuses to overwrite, then obeys --force', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tdai-plandex-'));
    try {
      const file = join(dir, 'custom-models.json');
      assert.equal(
        await run(['generate', '--output', file], {
          env: { TDAI_UPSTREAM_MODEL: 'gpt-5.5' },
          stdout: silent,
          stderr: silent,
        }),
        0,
      );
      JSON.parse(await readFile(file, 'utf8'));

      await writeFile(file, 'user edits');
      assert.equal(
        await run(['generate', '--output', file], {
          env: { TDAI_UPSTREAM_MODEL: 'gpt-5.5' },
          stdout: silent,
          stderr: silent,
        }),
        1,
      );
      assert.equal(await readFile(file, 'utf8'), 'user edits');

      assert.equal(
        await run(['generate', '--output', file, '--force'], {
          env: { TDAI_UPSTREAM_MODEL: 'gpt-5.5' },
          stdout: silent,
          stderr: silent,
        }),
        0,
      );
      JSON.parse(await readFile(file, 'utf8'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('run check', () => {
  const healthyFetch = async () => jsonResponse(200, { status: 'ok' });

  it('passes when proxy and core are healthy', async () => {
    let out = '';
    const code = await run(['check'], {
      env: { TDAI_UPSTREAM_MODEL: 'gpt-5.5', TDAI_USER_KEY: 'sk-mem-x' },
      fetchImpl: healthyFetch,
      stdout: { log: (s) => (out += `${s}\n`), error() {} },
      stderr: silent,
    });
    assert.equal(code, 0);
    assert.match(out, /model\s+gpt-5\.5/);
    assert.match(out, /space\s+default/);
    assert.match(out, /check passed/);
  });

  it('fails when the proxy is down and points at port 8096', async () => {
    let err = '';
    const code = await run(['check'], {
      env: { TDAI_UPSTREAM_MODEL: 'gpt-5.5', TDAI_USER_KEY: 'sk-mem-x' },
      fetchImpl: async (url) => {
        if (url.includes(':8096')) {
          return new Response('down', { status: 503 });
        }
        return jsonResponse(200, { status: 'ok' });
      },
      stdout: silent,
      stderr: { log: (s) => (err += s), error: (s) => (err += s) },
    });
    assert.equal(code, 1);
    assert.match(err, /proxy/i);
  });

  it('requires the business user key', async () => {
    const code = await run(['check'], {
      env: { TDAI_UPSTREAM_MODEL: 'gpt-5.5' },
      fetchImpl: healthyFetch,
      stdout: silent,
      stderr: silent,
    });
    assert.equal(code, 1);
  });

  it('warns, without failing, when the key does not look like a memory key', async () => {
    let err = '';
    const code = await run(['check'], {
      env: { TDAI_UPSTREAM_MODEL: 'gpt-5.5', TDAI_USER_KEY: 'not-a-memory-key' },
      fetchImpl: healthyFetch,
      stdout: silent,
      stderr: { log: (s) => (err += s), error: (s) => (err += s) },
    });
    assert.equal(code, 0);
    assert.match(err, /does not look like a Memory user key/i);
  });
});

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
