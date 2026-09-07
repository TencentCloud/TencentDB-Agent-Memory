import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

describe('package manifest', () => {
  it('is valid JSON with the expected adapter fields', async () => {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.name, '@tdai/plandex-adapter');
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.private, true);
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
    assert.ok(pkg.engines?.node, 'engines.node should pin the runtime');
    assert.ok(pkg.scripts?.test, 'npm test should be wired');
    assert.ok(pkg.scripts?.['test:coverage'], 'npm run test:coverage should be wired');
  });
});

describe('changelog', () => {
  it('exists and records the initial version', async () => {
    await access(join(root, 'CHANGELOG.md'));
    const text = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
    assert.match(text, /0\.1\.0/);
    assert.match(text, /Keep a Changelog/);
  });
});
