import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const docs = ['README.md', 'README_CN.md'];
const required = [
  'TDAI_MEMORY_GATEWAY_URL', 'TDAI_MEMORY_SERVICE_ID', 'TDAI_MEMORY_USER_ID', 'TDAI_MEMORY_API_KEY',
  'TDAI_MEMORY_TEAM_ID', 'TDAI_MEMORY_STATE_DIR', 'TDAI_MEMORY_CAPTURE_ENABLED', 'TDAI_MEMORY_RECALL_ENABLED',
  'install.mjs', 'uninstall.mjs', 'doctor.mjs', 'UserPromptSubmit', 'PostToolUse', 'Stop',
  '128KiB', '8KiB', '32KiB', 'outbox', 'fail-open', 'Kiro IDE', 'Full L0',
  'tdai_memory_search', 'tdai_conversation_search', 'tdai_memory_status',
  'environment > project > user > defaults', 'maintenance.mjs', 'migrate.mjs', 'status.mjs', 'health.mjs',
  'autoApprove', 'TDAI_MEMORY_SKILL_RECALL_ENABLED', 'TDAI_MEMORY_MCP_MAX_OUTPUT_CHARS',
  '.kiro/settings/tdai-memory.json', '~/.kiro/settings/tdai-memory.json',
  'https://kiro.dev/docs/hooks/',
  'maxItems=3', 'stale lock', '10,000',
];

test('English and Chinese guides document the same Phase 2 setup, safety, and limits', async () => {
  for (const doc of docs) {
    const source = await readFile(new URL(`../${doc}`, import.meta.url), 'utf8');
    for (const text of required) assert.equal(source.includes(text), true, `${doc} lacks ${text}`);
    assert.equal(source.includes('Kiro Web'), true);
    assert.equal(source.includes('remote Gateway E2E'), true);
    assert.equal(source.includes('will not automatically delete'), true);
    assert.equal(source.includes('API Key only'), true);
  }
});
