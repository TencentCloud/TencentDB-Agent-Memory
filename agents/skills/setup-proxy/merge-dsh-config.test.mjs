import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { mergeDshConfig } from './merge-dsh-config.mjs';

const execFileAsync = promisify(execFile);
const helperPath = fileURLToPath(new URL('./merge-dsh-config.mjs', import.meta.url));

async function withTemporaryConfig(run) {
  const directory = await mkdtemp(join(tmpdir(), 'tdb-dsh-config-'));
  const settingsPath = join(directory, 'settings.yaml');
  const credentialsPath = join(directory, '.credentials.yaml');

  try {
    await run({ directory, settingsPath, credentialsPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('合并配置时保留用户已有 namespace、注释和其他凭据', async () => {
  await withTemporaryConfig(async ({ settingsPath, credentialsPath }) => {
    const originalSettings = `# 用户自己的配置
ui:
  theme: dark

llm-deepseek:
  # 保留这条注释
  apiKeyEnv: OLD_KEY
  baseURL: https://old.example.com
  reasoningEffort: low
  model: legacy-wrong-place
  models:
    deepseek-chat:
      contextWindow: 64000
  customOption: keep-me

agent-default-model:
  provider: another-provider
  model: old-model
  reasoningEffort: medium
`;
    const originalCredentials = `version: 1
refs:
  DEEPSEEK_API_KEY: keep-this-secret
  PROXY_USER_KEY: old-proxy-key
records:
  oauth/example:
    kind: grant
    payload:
      refresh_token: keep-this-record
`;

    await writeFile(settingsPath, originalSettings);
    await writeFile(credentialsPath, originalCredentials);

    await mergeDshConfig({
      settingsPath,
      credentialsPath,
      baseUrl: 'https://proxy.example.com/dsh/instance-a',
      model: 'deepseek-v3.2',
      userKey: 'new-proxy-key',
    });

    const settings = await readFile(settingsPath, 'utf8');
    const credentials = await readFile(credentialsPath, 'utf8');

    assert.match(settings, /ui:\n  theme: dark/);
    assert.match(settings, /# 保留这条注释/);
    assert.match(settings, /customOption: keep-me/);
    assert.match(settings, /contextWindow: 64000/);
    assert.match(settings, /apiKeyEnv: "PROXY_USER_KEY"/);
    assert.match(settings, /baseURL: "https:\/\/proxy\.example\.com\/dsh\/instance-a"/);
    assert.match(settings, /reasoningEffort: low/);
    assert.match(settings, /agent-default-model:\n  provider: "deepseek-official"\n  model: "deepseek-v3\.2"/);
    assert.match(settings, /reasoningEffort: medium/);
    assert.doesNotMatch(settings, /legacy-wrong-place/);

    assert.match(credentials, /version: 1/);
    assert.match(credentials, /  DEEPSEEK_API_KEY: keep-this-secret/);
    assert.match(credentials, /  PROXY_USER_KEY: "new-proxy-key"/);
    assert.match(credentials, /refresh_token: keep-this-record/);
    assert.doesNotMatch(credentials, /^PROXY_USER_KEY:/m);
  });
});

test('配置文件不存在时生成 dsh 所需的两个 namespace', async () => {
  await withTemporaryConfig(async ({ settingsPath, credentialsPath }) => {
    await mergeDshConfig({
      settingsPath,
      credentialsPath,
      baseUrl: 'http://127.0.0.1:3000/dsh/local',
      model: 'deepseek-chat',
      userKey: 'key-with-#-and-:colon',
    });

    const settings = await readFile(settingsPath, 'utf8');
    const credentials = await readFile(credentialsPath, 'utf8');

    assert.match(settings, /llm-deepseek:/);
    assert.match(settings, /agent-default-model:/);
    assert.match(settings, /provider: "deepseek-official"/);
    assert.match(settings, /model: "deepseek-chat"/);
    assert.equal(
      credentials.includes('  PROXY_USER_KEY: "key-with-#-and-:colon"'),
      true,
    );
    assert.match(credentials, /^version: 1$/m);
  });
});

test('遇到无法安全增量修改的行内 YAML 时不改动任一文件', async () => {
  await withTemporaryConfig(async ({ settingsPath, credentialsPath }) => {
    const originalSettings = 'llm-deepseek: { baseURL: "https://old.example.com" }\n';
    const originalCredentials = 'version: 1\nrefs:\n  EXISTING_KEY: keep-me\n';
    await writeFile(settingsPath, originalSettings);
    await writeFile(credentialsPath, originalCredentials);

    await assert.rejects(
      mergeDshConfig({
        settingsPath,
        credentialsPath,
        baseUrl: 'https://proxy.example.com/dsh/instance-a',
        model: 'deepseek-chat',
        userKey: 'new-key',
      }),
      /行内 YAML/,
    );

    assert.equal(await readFile(settingsPath, 'utf8'), originalSettings);
    assert.equal(await readFile(credentialsPath, 'utf8'), originalCredentials);
  });
});

test('重复执行只更新受管字段，不产生重复 key', async () => {
  await withTemporaryConfig(async ({ settingsPath, credentialsPath }) => {
    const firstRun = {
      settingsPath,
      credentialsPath,
      baseUrl: 'https://proxy.example.com/dsh/one',
      model: 'model-one',
      userKey: 'key-one',
    };
    await mergeDshConfig(firstRun);
    await mergeDshConfig({
      ...firstRun,
      baseUrl: 'https://proxy.example.com/dsh/two',
      model: 'model-two',
      userKey: 'key-two',
    });

    const settings = await readFile(settingsPath, 'utf8');
    const credentials = await readFile(credentialsPath, 'utf8');

    assert.equal((settings.match(/^llm-deepseek:/gm) ?? []).length, 1);
    assert.equal((settings.match(/^agent-default-model:/gm) ?? []).length, 1);
    assert.equal((settings.match(/^  model:/gm) ?? []).length, 1);
    assert.match(settings, /baseURL: "https:\/\/proxy\.example\.com\/dsh\/two"/);
    assert.match(settings, /model: "model-two"/);
    assert.equal((credentials.match(/^  PROXY_USER_KEY:/gm) ?? []).length, 1);
    assert.match(credentials, /  PROXY_USER_KEY: "key-two"/);
  });
});

test('命令行入口能接收 setup-proxy.sh 传入的参数', async () => {
  await withTemporaryConfig(async ({ settingsPath, credentialsPath }) => {
    await execFileAsync(process.execPath, [
      helperPath,
      '--settings',
      settingsPath,
      '--credentials',
      credentialsPath,
      '--base-url',
      'https://proxy.example.com/dsh/cli',
      '--model',
      'cli-model',
    ], {
      env: { ...process.env, TDAI_DSH_PROXY_USER_KEY: 'cli-key' },
    });

    assert.match(await readFile(settingsPath, 'utf8'), /model: "cli-model"/);
    assert.match(await readFile(credentialsPath, 'utf8'), /  PROXY_USER_KEY: "cli-key"/);
  });
});

test('旧版扁平凭据会迁移到 version 1 refs 并保留注释', async () => {
  await withTemporaryConfig(async ({ settingsPath, credentialsPath }) => {
    await writeFile(credentialsPath, `# keep this note
DEEPSEEK_API_KEY: keep-this-secret
PROXY_USER_KEY: old-key
`);

    await mergeDshConfig({
      settingsPath,
      credentialsPath,
      baseUrl: 'https://proxy.example.com/dsh/migrated',
      model: 'deepseek-chat',
      userKey: 'new-key',
    });

    const credentials = await readFile(credentialsPath, 'utf8');
    assert.match(credentials, /^version: 1$/m);
    assert.match(credentials, /^refs:$/m);
    assert.match(credentials, /^  # keep this note$/m);
    assert.match(credentials, /^  DEEPSEEK_API_KEY: keep-this-secret$/m);
    assert.match(credentials, /^  PROXY_USER_KEY: "new-key"$/m);
  });
});

test('拒绝修改未知版本凭据且不改动 settings', async () => {
  await withTemporaryConfig(async ({ settingsPath, credentialsPath }) => {
    const originalSettings = 'ui:\n  theme: dark\n';
    const originalCredentials = 'version: 2\nrefs: {}\n';
    await writeFile(settingsPath, originalSettings);
    await writeFile(credentialsPath, originalCredentials);

    await assert.rejects(
      mergeDshConfig({
        settingsPath,
        credentialsPath,
        baseUrl: 'https://proxy.example.com/dsh/instance-a',
        model: 'deepseek-chat',
        userKey: 'new-key',
      }),
      /version: 1/,
    );

    assert.equal(await readFile(settingsPath, 'utf8'), originalSettings);
    assert.equal(await readFile(credentialsPath, 'utf8'), originalCredentials);
  });
});
