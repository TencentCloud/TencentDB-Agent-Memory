import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const sourceFiles = [
  'tdai-plandex.mjs',
  ...(await readdir(join(root, 'lib'))).filter((name) => name.endsWith('.mjs')).map((name) => `lib/${name}`),
];

describe('source quality guard', () => {
  for (const file of sourceFiles) {
    it(`${file} has no TODO/FIXME/XXX markers`, async () => {
      const text = await readFile(join(root, file), 'utf8');
      assert.doesNotMatch(text, /\b(TODO|FIXME|XXX)\b/);
    });

    it(`${file} does not write secrets or debug output`, async () => {
      const text = await readFile(join(root, file), 'utf8');
      assert.doesNotMatch(text, /ghp_[A-Za-z0-9]{20,}/);
      assert.doesNotMatch(text, /sk-mem-[A-Za-z0-9]{20,}/);
      assert.doesNotMatch(text, /console\.log\(/);
    });
  }
});
