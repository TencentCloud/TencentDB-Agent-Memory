export const PROVIDER_NAME = 'tencentdb-agent-memory';
export const MODEL_ID = 'tdai-memory-agent';
export const PUBLISHER = 'tencentdb';
export const PACK_NAME = 'tdai-memory-pack';
export const API_KEY_ENV_VAR = 'TDAI_USER_KEY';
export const SCHEMA_URL = 'https://plandex.ai/schemas/models-input.schema.json';

export const DEFAULTS = Object.freeze({
  proxyBaseUrl: 'http://127.0.0.1:8096',
  coreBaseUrl: 'http://127.0.0.1:8420',
  spaceId: 'default',
  maxOutputTokens: 8192,
  defaultMaxConvoTokens: 128000,
});

export function normalizeBaseUrl(raw, label = 'URL') {
  if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw)) {
    throw new Error(
      `${label} must start with http:// or https:// (got: ${JSON.stringify(raw)})`,
    );
  }
  const url = new URL(raw);
  if (url.username || url.password) {
    throw new Error(`${label} must not embed credentials`);
  }
  if (url.search || url.hash) {
    throw new Error(`${label} must not contain a query string or fragment`);
  }
  return url.toString().replace(/\/+$/, '');
}

export function validateSpaceId(spaceId) {
  if (typeof spaceId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(spaceId)) {
    throw new Error(
      `Invalid space id: ${JSON.stringify(spaceId)} (allowed: letters, digits, "_" and "-")`,
    );
  }
  return spaceId;
}

const envStr = (env, name) => {
  const value = env[name];
  return typeof value === 'string' ? value.trim() : undefined;
};

const envInt = (env, name, fallback) => {
  const value = envStr(env, name);
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer (got: ${JSON.stringify(value)})`);
  }
  return parsed;
};

export function parseEnv(env = process.env) {
  const upstreamModel = envStr(env, 'TDAI_UPSTREAM_MODEL');
  if (!upstreamModel) {
    throw new Error(
      'TDAI_UPSTREAM_MODEL is required: set it to the model id configured in the MemoryProxy PROXY_UPSTREAM_MODEL (e.g. gpt-5.5).',
    );
  }

  let spaceId;
  try {
    spaceId = validateSpaceId(envStr(env, 'TDAI_SPACE_ID') ?? DEFAULTS.spaceId);
  } catch (error) {
    throw new Error(`TDAI_SPACE_ID: ${error.message}`);
  }

  return {
    upstreamModel,
    proxyBaseUrl: normalizeBaseUrl(
      envStr(env, 'TDAI_PROXY_BASE_URL') ?? DEFAULTS.proxyBaseUrl,
      'TDAI_PROXY_BASE_URL',
    ),
    coreBaseUrl: normalizeBaseUrl(
      envStr(env, 'TDAI_CORE_BASE_URL') ?? DEFAULTS.coreBaseUrl,
      'TDAI_CORE_BASE_URL',
    ),
    spaceId,
    userKey: envStr(env, 'TDAI_USER_KEY'),
    maxOutputTokens: envInt(env, 'TDAI_MAX_OUTPUT_TOKENS', DEFAULTS.maxOutputTokens),
    defaultMaxConvoTokens: envInt(
      env,
      'TDAI_DEFAULT_MAX_CONVO_TOKENS',
      DEFAULTS.defaultMaxConvoTokens,
    ),
  };
}

export function buildProvider(cfg = {}) {
  const proxyBaseUrl = cfg.proxyBaseUrl ?? DEFAULTS.proxyBaseUrl;
  const spaceId = cfg.spaceId ?? DEFAULTS.spaceId;
  return {
    name: PROVIDER_NAME,
    baseUrl: `${proxyBaseUrl}/proxy/${spaceId}/v1`,
    apiKeyEnvVar: API_KEY_ENV_VAR,
  };
}

export function buildModel(cfg = {}) {
  if (!cfg.upstreamModel) {
    throw new Error('upstreamModel is required to build the Plandex model mapping');
  }
  const maxOutputTokens = cfg.maxOutputTokens ?? DEFAULTS.maxOutputTokens;
  const defaultMaxConvoTokens = cfg.defaultMaxConvoTokens ?? DEFAULTS.defaultMaxConvoTokens;
  return {
    modelId: MODEL_ID,
    publisher: PUBLISHER,
    description:
      'Routes Plandex through TencentDB Agent Memory so conversations, skills, wiki knowledge and code graphs are captured and re-injected as team memory.',
    defaultMaxConvoTokens,
    maxOutputTokens,
    reservedOutputTokens: maxOutputTokens,
    preferredOutputFormat: 'xml',
    providers: [
      {
        provider: 'custom',
        customProvider: PROVIDER_NAME,
        modelName: cfg.upstreamModel,
      },
    ],
  };
}

export function buildModelPack(cfg) {
  const ref = `${PUBLISHER}/${MODEL_ID}`;
  return {
    name: PACK_NAME,
    description: 'Every Plandex role runs through TencentDB Agent Memory.',
    planner: ref,
    coder: ref,
    architect: ref,
    summarizer: ref,
    builder: {
      modelId: ref,
      strongModel: ref,
    },
    names: ref,
    commitMessages: ref,
  };
}

export function buildCustomModelsFile(cfg) {
  return {
    $schema: SCHEMA_URL,
    providers: [buildProvider(cfg)],
    models: [buildModel(cfg)],
    modelPacks: [buildModelPack(cfg)],
  };
}

export function serializeCustomModels(cfg) {
  return `${JSON.stringify(buildCustomModelsFile(cfg), null, 2)}\n`;
}
