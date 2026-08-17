import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// The official Season 2 rule requires EN and CN docs in the same PR.
// This guard mirrors that rule so it can never regress silently.
describe('bilingual documentation guard', () => {
  for (const file of ['README.md', 'README_CN.md']) {
    it(`${file} exists and is a real guide`, async () => {
      await access(join(root, file));
      const text = await readFile(join(root, file), 'utf8');
      assert.ok(text.trim().length > 500, `${file} should be a guide, not a stub`);
      assert.match(text, /tencentdb-agent-memory/i);
      assert.match(text, /\/proxy\//);
      assert.match(text, /TDAI_USER_KEY/);
    });
  }
});
