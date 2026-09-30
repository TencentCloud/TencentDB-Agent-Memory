import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const REQUIRED_TERMS = [
  'TDAI_UPSTREAM_MODEL',
  'TDAI_USER_KEY',
  'TDAI_PROXY_BASE_URL',
  'TDAI_CORE_BASE_URL',
  'TDAI_SPACE_ID',
  'generate',
  'check',
];

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
      for (const term of REQUIRED_TERMS) {
        assert.ok(text.includes(term), `${file} must document "${term}"`);
      }
    });

    it(`${file} has no broken local links`, async () => {
      const text = await readFile(join(root, file), 'utf8');
      const targets = [...text.matchAll(/\]\(([^)]+)\)/g)]
        .map((match) => match[1].trim())
        .filter((target) => !/^(https?:|#)/.test(target));

      assert.ok(targets.length > 0, `${file} should reference at least one local file`);
      for (const target of targets) {
        const path = target.split('#')[0];
        try {
          await access(join(root, path));
        } catch {
          throw new Error(`broken link in ${file}: ${target}`);
        }
      }
    });
  }
});
