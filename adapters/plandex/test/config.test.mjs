import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  API_KEY_ENV_VAR,
  DEFAULTS,
  MODEL_ID,
  PACK_NAME,
  PROVIDER_NAME,
  PUBLISHER,
  SCHEMA_URL,
  buildCustomModelsFile,
  buildModel,
  buildModelPack,
  buildProvider,
  normalizeBaseUrl,
  parseEnv,
  serializeCustomModels,
  validateSpaceId,
} from '../lib/config.mjs';

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes', () => {
    assert.equal(normalizeBaseUrl('http://127.0.0.1:8096///'), 'http://127.0.0.1:8096');
  });

  it('rejects non-http(s) URLs', () => {
    assert.throws(() => normalizeBaseUrl('ftp://proxy'), /must start with http/);
    assert.throws(() => normalizeBaseUrl('localhost:8096'), /must start with http/);
  });

  it('rejects query strings and fragments', () => {
    assert.throws(() => normalizeBaseUrl('http://127.0.0.1:8096?x=1'), /query|fragment/i);
    assert.throws(() => normalizeBaseUrl('http://127.0.0.1:8096#x'), /query|fragment/i);
  });
});

describe('validateSpaceId', () => {
  it('accepts safe identifiers', () => {
    assert.doesNotThrow(() => validateSpaceId('default'));
    assert.doesNotThrow(() => validateSpaceId('team-a_1'));
  });

  it('rejects unsafe identifiers', () => {
    for (const bad of ['', '../x', 'a b', 'a/b', 'a?b', 'a#b']) {
      assert.throws(() => validateSpaceId(bad));
    }
  });
});

describe('parseEnv', () => {
  it('applies documented defaults', () => {
    const cfg = parseEnv({ TDAI_UPSTREAM_MODEL: 'gpt-5.5' });
    assert.equal(cfg.proxyBaseUrl, DEFAULTS.proxyBaseUrl);
    assert.equal(cfg.coreBaseUrl, DEFAULTS.coreBaseUrl);
    assert.equal(cfg.spaceId, DEFAULTS.spaceId);
    assert.equal(cfg.upstreamModel, 'gpt-5.5');
    assert.equal(cfg.userKey, undefined);
    assert.equal(cfg.maxOutputTokens, DEFAULTS.maxOutputTokens);
    assert.equal(cfg.defaultMaxConvoTokens, DEFAULTS.defaultMaxConvoTokens);
  });

  it('reads custom values and normalizes base URLs', () => {
    const cfg = parseEnv({
      TDAI_UPSTREAM_MODEL: 'm',
      TDAI_PROXY_BASE_URL: 'http://proxy:1/',
      TDAI_CORE_BASE_URL: 'http://core:2/',
      TDAI_SPACE_ID: 'prod',
      TDAI_USER_KEY: 'sk-mem-x',
      TDAI_MAX_OUTPUT_TOKENS: '4096',
      TDAI_DEFAULT_MAX_CONVO_TOKENS: '60000',
    });
    assert.equal(cfg.proxyBaseUrl, 'http://proxy:1');
    assert.equal(cfg.coreBaseUrl, 'http://core:2');
    assert.equal(cfg.spaceId, 'prod');
    assert.equal(cfg.userKey, 'sk-mem-x');
    assert.equal(cfg.maxOutputTokens, 4096);
    assert.equal(cfg.defaultMaxConvoTokens, 60000);
  });

  it('fails with an actionable message when the upstream model is missing', () => {
    assert.throws(() => parseEnv({}), /TDAI_UPSTREAM_MODEL/);
    assert.throws(() => parseEnv({ TDAI_UPSTREAM_MODEL: '  ' }), /TDAI_UPSTREAM_MODEL/);
  });

  it('fails on invalid base URLs and space ids', () => {
    assert.throws(() => parseEnv({ TDAI_UPSTREAM_MODEL: 'm', TDAI_PROXY_BASE_URL: 'nope' }), /TDAI_PROXY_BASE_URL/);
    assert.throws(() => parseEnv({ TDAI_UPSTREAM_MODEL: 'm', TDAI_SPACE_ID: '../x' }), /TDAI_SPACE_ID/);
  });
});

describe('buildProvider', () => {
  it('maps to the proxy OpenAI-compatible route', () => {
    const provider = buildProvider({ proxyBaseUrl: 'http://127.0.0.1:8096', spaceId: 'default' });
    assert.deepEqual(provider, {
      name: PROVIDER_NAME,
      baseUrl: 'http://127.0.0.1:8096/proxy/default/v1',
      apiKeyEnvVar: API_KEY_ENV_VAR,
    });
  });
});

describe('buildModel', () => {
  it('maps the upstream model through the custom provider', () => {
    const model = buildModel({
      upstreamModel: 'gpt-5.5',
      maxOutputTokens: 8192,
      defaultMaxConvoTokens: 128000,
    });
    assert.equal(model.modelId, MODEL_ID);
    assert.equal(model.publisher, PUBLISHER);
    assert.equal(model.preferredOutputFormat, 'xml');
    assert.equal(model.maxOutputTokens, 8192);
    assert.equal(model.defaultMaxConvoTokens, 128000);
    assert.equal(model.providers.length, 1);
    assert.equal(model.providers[0].provider, 'custom');
    assert.equal(model.providers[0].customProvider, PROVIDER_NAME);
    assert.equal(model.providers[0].modelName, 'gpt-5.5');
  });
});

describe('buildModelPack', () => {
  it('assigns the memory-backed model to every role', () => {
    const pack = buildModelPack({});
    const ref = `${PUBLISHER}/${MODEL_ID}`;
    assert.equal(pack.name, PACK_NAME);
    for (const value of [
      pack.planner,
      pack.coder,
      pack.architect,
      pack.summarizer,
      pack.names,
      pack.commitMessages,
    ]) {
      assert.equal(value, ref);
    }
    assert.equal(pack.builder.modelId, ref);
    assert.equal(pack.builder.strongModel, ref);
  });
});

describe('buildCustomModelsFile', () => {
  it('produces the documented plandex models-input shape', () => {
    const cfg = {
      proxyBaseUrl: 'http://127.0.0.1:8096',
      spaceId: 'default',
      upstreamModel: 'gpt-5.5',
      maxOutputTokens: 8192,
      defaultMaxConvoTokens: 128000,
    };
    const file = buildCustomModelsFile(cfg);
    assert.equal(file.$schema, SCHEMA_URL);
    assert.equal(file.providers.length, 1);
    assert.equal(file.models.length, 1);
    assert.equal(file.modelPacks.length, 1);
    assert.deepEqual(file.providers[0], buildProvider(cfg));
    assert.deepEqual(file.models[0], buildModel(cfg));
    assert.deepEqual(file.modelPacks[0], buildModelPack(cfg));
  });
});

describe('serializeCustomModels', () => {
  it('emits pretty JSON with a trailing newline', () => {
    const text = serializeCustomModels({
      proxyBaseUrl: 'http://127.0.0.1:8096',
      spaceId: 'default',
      upstreamModel: 'gpt-5.5',
    });
    assert.ok(text.endsWith('\n'));
    assert.ok(text.includes('\n  "providers"'));
    const parsed = JSON.parse(text);
    assert.equal(parsed.$schema, SCHEMA_URL);
  });
});
