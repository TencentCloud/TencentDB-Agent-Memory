import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';

import { ConfigError, resolveConfig } from '../src/core/config.js';

const baseEnv = {
  TDAI_MEMORY_GATEWAY_URL: 'https://env.example.com',
  TDAI_MEMORY_SERVICE_ID: 'env-service',
  TDAI_MEMORY_USER_ID: 'env-user',
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kiro-config-v2-'));
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  await mkdir(join(workspace, '.kiro', 'settings'), { recursive: true });
  await mkdir(join(home, '.kiro', 'settings'), { recursive: true });
  return {
    root,
    workspace,
    home,
    projectPath: join(workspace, '.kiro', 'settings', 'tdai-memory.json'),
    userPath: join(home, '.kiro', 'settings', 'tdai-memory.json'),
  };
}

const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

test('resolves config field-by-field as environment over project over user over defaults', async () => {
  const f = await fixture();
  try {
    await writeJson(f.userPath, {
      version: 2,
      gatewayUrl: 'https://user.example.com',
      serviceId: 'user-service',
      userId: 'user-id',
      teamId: 'user-team',
      maxContextChars: 7000,
    });
    await writeJson(f.projectPath, {
      version: 2,
      gatewayUrl: 'https://project.example.com',
      serviceId: 'project-service',
      userId: 'project-user',
      teamId: 'project-team',
      maxRecallResults: 7,
    });
    const { config, provenance } = await resolveConfig({
      env: { ...baseEnv, TDAI_MEMORY_TIMEOUT_MS: '1234' },
      workspace: f.workspace,
      homedir: f.home,
    });

    assert.equal(config.gatewayUrl, 'https://env.example.com');
    assert.equal(config.teamId, 'project-team');
    assert.equal(config.maxContextChars, 7000);
    assert.equal(config.maxRecallResults, 7);
    assert.equal(config.timeoutMs, 1234);
    assert.equal(config.agentId, 'kiro');
    assert.equal(config.conversationRecallEnabled, true);
    assert.equal(config.skillRecallEnabled, true);
    assert.equal(config.mcpMaxOutputChars, 12000);
    assert.equal(config.apiKey, undefined);
    assert.equal(isAbsolute(config.stateDir), true);
    assert.equal(provenance.gatewayUrl, 'environment');
    assert.equal(provenance.teamId, 'project');
    assert.equal(provenance.maxContextChars, 'user');
    assert.equal(provenance.agentId, 'default');
    assert.equal(Object.isFrozen(config), true);
    assert.equal(Object.isFrozen(provenance), true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('keeps the API key environment-only and never includes values in config errors', async () => {
  const f = await fixture();
  try {
    const secret = 'do-not-leak-secret-value';
    await writeJson(f.projectPath, { version: 2, nested: { apiKey: secret } });
    await assert.rejects(
      resolveConfig({ env: baseEnv, workspace: f.workspace, homedir: f.home }),
      (error) => error instanceof ConfigError
        && error.field === 'nested.apiKey'
        && error.source === 'project'
        && !error.message.includes(secret),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('rejects unknown keys, invalid versions, malformed JSON, and non-object files', async () => {
  const cases = [
    ['unknown', JSON.stringify({ version: 2, surprise: true }), 'surprise'],
    ['version', JSON.stringify({ version: 1 }), 'version'],
    ['json', '{"version":2,', '$'],
    ['shape', '[]', '$'],
  ];
  for (const [name, source, field] of cases) {
    const f = await fixture();
    try {
      await writeFile(f.projectPath, source);
      await assert.rejects(
        resolveConfig({ env: baseEnv, workspace: f.workspace, homedir: f.home }),
        (error) => error instanceof ConfigError
          && error.source === 'project'
          && error.field === field,
        name,
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test('rejects duplicate semantic JSON fields instead of silently accepting the last value', async () => {
  const f = await fixture();
  try {
    await writeFile(f.projectPath, '{"version":2,"serviceId":"first","serviceId":"second"}');
    await assert.rejects(
      resolveConfig({ env: baseEnv, workspace: f.workspace, homedir: f.home }),
      (error) => error instanceof ConfigError && error.source === 'project' && error.field === '$',
    );
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('validates merged URL, identifiers, ranges, booleans, and absolute state root safely', async () => {
  const cases = [
    ['gatewayUrl', { gatewayUrl: 'https://name:password@example.com' }],
    ['gatewayUrl', { gatewayUrl: 'https://example.com/path?q=secret' }],
    ['teamId', { teamId: 'bad|team' }],
    ['agentId', { agentId: '' }],
    ['timeoutMs', { timeoutMs: 3001 }],
    ['maxRecallResults', { maxRecallResults: 0 }],
    ['maxContextChars', { maxContextChars: 511 }],
    ['mcpMaxOutputChars', { mcpMaxOutputChars: 32001 }],
    ['recallEnabled', { recallEnabled: 'true' }],
    ['stateDir', { stateDir: 'relative/state' }],
  ];
  for (const [field, layer] of cases) {
    const f = await fixture();
    try {
      await writeJson(f.projectPath, {
        version: 2,
        gatewayUrl: 'https://valid.example.com',
        serviceId: 'service',
        userId: 'user',
        ...layer,
      });
      await assert.rejects(
        resolveConfig({ env: {}, workspace: f.workspace, homedir: f.home }),
        (error) => error instanceof ConfigError
          && error.field === field
          && (String(layer[field]).length === 0 || !error.message.includes(String(layer[field]))),
        field,
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});
