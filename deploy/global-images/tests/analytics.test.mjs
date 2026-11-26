import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const launchers = fileURLToPath(new URL('../', import.meta.url));
const dockerStub = [
  '#!/usr/bin/env bash',
  '[[ "$1" == run ]] || exit 0',
  'while (( $# )); do',
  '  if [[ "$1" == -e ]]; then',
  '    shift',
  '    if [[ "$1" == *=* ]]; then',
  '      printf "%s\\n" "$1"',
  '    elif value=$(printenv "$1"); then',
  '      printf "%s=%s\\n" "$1" "$value"',
  '    fi',
  '  fi',
  '  shift',
  'done > "$CAPTURE_PATH"',
  'exit 42',
].join('\n');

function launch(t, launcher, settings, expectedStatus = 42) {
  const dir = mkdtempSync(join(tmpdir(), 'global-images-analytics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envFile = join(dir, '.env');
  const capturePath = join(dir, 'docker-env');
  const common = {
    MEMORY_CORE_IMAGE: 'memory-core:test',
    MEMORY_HUB_IMAGE: 'memory-hub:test',
    PROXY_IMAGE: 'proxy:test',
    MEMORY_CORE_PORT: '8420',
    PANEL_PORT: '8125',
    KNOWLEDGE_PORT: '8424',
    PROXY_PORT: '8096',
    MEMORY_CORE_VOLUME: 'core',
    PANEL_VOLUME: 'knowledge',
    MEMORY_LLM_BASE_URL: 'https://llm.test/v1',
    MEMORY_LLM_API_KEY: 'test-key',
    MEMORY_LLM_MODEL: 'test-model',
    PROXY_UPSTREAM_URL: 'https://llm.test/v1',
    PROXY_UPSTREAM_API_KEY: 'test-key',
    PROXY_UPSTREAM_MODEL: 'test-model',
    KNOWLEDGE_PUBLIC_BASE_URL: 'http://knowledge:8424/v3',
    KNOWLEDGE_SERVICE_KEY: 'test-service-key',
    MEMORY_HUB_PROXY_PUBLIC_URL: 'http://proxy:8096',
    MEMORY_CORE_CONFIG_DIR: dir,
    PROXY_CONFIG_DIR: dir,
  };
  const envContents = Object.entries({ ...common, ...settings })
    .map(([key, value]) => key + "='" + value.replaceAll("'", "'\\''") + "'")
    .join('\n');
  writeFileSync(envFile, envContents);
  writeFileSync(join(dir, 'docker'), dockerStub, { mode: 0o755 });
  const result = spawnSync('bash', [join(launchers, launcher)], {
    encoding: 'utf8',
    env: { PATH: dir + ':' + process.env.PATH, ENV_FILE: envFile, CAPTURE_PATH: capturePath },
  });
  assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
  if (expectedStatus !== 42) return { stderr: result.stderr };
  return { env: readFileSync(capturePath, 'utf8'), dir };
}

const settings = {
  ANALYTICS_CLICKHOUSE_ENABLED: 'true',
  ANALYTICS_CLICKHOUSE_ENDPOINT: 'http://tdai-clickhouse:8123',
  ANALYTICS_CLICKHOUSE_DATABASE: 'analytics_test',
  ANALYTICS_CLICKHOUSE_USERNAME: 'analytics_user',
  ANALYTICS_CLICKHOUSE_PASSWORD: 'test\\password:"with # and spaces"',
  PANEL_FEATURE_ANALYTICS_ENABLED: 'true',
};

test('the one-click launchers wire a shared ClickHouse connection', (t) => {
  const core = launch(t, 'start-memory-core.sh', settings);
  for (const [key, value] of Object.entries(settings)) {
    if (key.startsWith('ANALYTICS_')) assert.ok(core.env.includes(key + '=' + value + '\n'), key);
  }

  const hub = launch(t, 'start-memory-hub.sh', settings);
  for (const entry of [
    'PANEL_FEATURE_ANALYTICS_ENABLED=true',
    'KNOWLEDGE_CLICKHOUSE_ENABLED=true',
    'KNOWLEDGE_CLICKHOUSE_URL=' + settings.ANALYTICS_CLICKHOUSE_ENDPOINT,
    'KNOWLEDGE_CLICKHOUSE_DATABASE=' + settings.ANALYTICS_CLICKHOUSE_DATABASE,
    'KNOWLEDGE_CLICKHOUSE_USER=' + settings.ANALYTICS_CLICKHOUSE_USERNAME,
    'KNOWLEDGE_CLICKHOUSE_PASSWORD=' + settings.ANALYTICS_CLICKHOUSE_PASSWORD,
    'KNOWLEDGE_SERVICE_KEY=test-service-key',
    'KNOWLEDGE_AUTH_TOKEN=test-service-key',
  ]) assert.ok(hub.env.includes(entry + '\n'), entry.split('=')[0]);

  const proxy = launch(t, 'start-proxy.sh', settings);
  const yaml = readFileSync(join(proxy.dir, 'config.yaml'), 'utf8');
  const clickhouse = yaml.split('\nclickhouse:\n')[1];
  assert.ok(clickhouse);
  assert.match(clickhouse, /^  enabled: true$/m);
  for (const [key, value] of Object.entries({
    url: settings.ANALYTICS_CLICKHOUSE_ENDPOINT,
    database: settings.ANALYTICS_CLICKHOUSE_DATABASE,
    user: settings.ANALYTICS_CLICKHOUSE_USERNAME,
    password: settings.ANALYTICS_CLICKHOUSE_PASSWORD,
  })) {
    const line = clickhouse.split('\n').find((line) => line.startsWith('  ' + key + ': '));
    assert.equal(JSON.parse(line.slice(key.length + 4)), value, key);
  }
});

test('analytics remains optional and Knowledge can be disabled separately', (t) => {
  const proxy = launch(t, 'start-proxy.sh', {});
  assert.doesNotMatch(readFileSync(join(proxy.dir, 'config.yaml'), 'utf8'), /^clickhouse:/m);

  const hub = launch(t, 'start-memory-hub.sh', {});
  assert.match(hub.env, /^PANEL_FEATURE_ANALYTICS_ENABLED=false$/m);
  assert.match(hub.env, /^KNOWLEDGE_CLICKHOUSE_ENABLED=false$/m);

  const coreOnlyHub = launch(t, 'start-memory-hub.sh', {
    ...settings,
    KNOWLEDGE_CLICKHOUSE_ENABLED: 'false',
    KNOWLEDGE_CLICKHOUSE_PASSWORD: '',
  });
  assert.match(coreOnlyHub.env, /^PANEL_FEATURE_ANALYTICS_ENABLED=true$/m);
  assert.match(coreOnlyHub.env, /^KNOWLEDGE_CLICKHOUSE_ENABLED=false$/m);
  assert.match(coreOnlyHub.env, /^KNOWLEDGE_CLICKHOUSE_PASSWORD=$/m);
});

test('an enabled configuration requires a ClickHouse endpoint', (t) => {
  for (const launcher of ['start-memory-core.sh', 'start-memory-hub.sh', 'start-proxy.sh']) {
    const { stderr } = launch(t, launcher, { ANALYTICS_CLICKHOUSE_ENABLED: 'true' }, 1);
    assert.match(stderr, /ANALYTICS_CLICKHOUSE_ENDPOINT/);
  }
});
