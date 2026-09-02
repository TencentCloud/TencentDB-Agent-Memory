import { homedir as defaultHomedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { readConfigLayer } from './config-file.js';

export class ConfigError extends Error {
  constructor(message, { field, source, category } = {}) {
    super(message);
    this.name = 'ConfigError';
    this.field = field;
    this.source = source;
    this.category = category;
  }
}

const safeError = (field, source, category) => new ConfigError(
  `Invalid configuration: ${source}:${field}:${category}`,
  { field, source, category },
);

const readRequiredString = (env, name) => {
  const value = env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConfigError(`${name} is required`);
  }
  return value;
};

const readBoolean = (env, name, defaultValue) => {
  const value = env[name];
  if (value === undefined) return defaultValue;
  if (typeof value === 'string' && value.toLowerCase() === 'true') return true;
  if (typeof value === 'string' && value.toLowerCase() === 'false') return false;
  throw new ConfigError(`${name} must be true or false`);
};

const readInteger = (env, name, defaultValue, minimum, maximum = Infinity) => {
  const value = env[name];
  if (value === undefined) return defaultValue;
  const parsed = typeof value === 'string' && value.trim().length > 0 ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigError(`${name} must be an integer in the allowed range`);
  }
  return parsed;
};

const readGatewayUrl = (env) => {
  const value = readRequiredString(env, 'TDAI_MEMORY_GATEWAY_URL');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError('TDAI_MEMORY_GATEWAY_URL must be an http or https URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError('TDAI_MEMORY_GATEWAY_URL must be an http or https URL');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ConfigError('TDAI_MEMORY_GATEWAY_URL must not include userinfo, query, or fragment');
  }
  return value.replace(/\/+$/, '');
};

export function loadConfig(env = process.env, options = {}) {
  const gatewayUrl = readGatewayUrl(env);
  const serviceId = readRequiredString(env, 'TDAI_MEMORY_SERVICE_ID');
  const userId = readRequiredString(env, 'TDAI_MEMORY_USER_ID');
  const apiKey = typeof env.TDAI_MEMORY_API_KEY === 'string' && env.TDAI_MEMORY_API_KEY.length > 0
    ? env.TDAI_MEMORY_API_KEY
    : undefined;
  const logLevel = env.TDAI_MEMORY_LOG_LEVEL ?? 'warn';
  if (!new Set(['error', 'warn', 'info', 'debug']).has(logLevel)) {
    throw new ConfigError('TDAI_MEMORY_LOG_LEVEL must be error, warn, info, or debug');
  }
  const homedir = options.homedir ?? defaultHomedir;
  const stateDir = env.TDAI_MEMORY_STATE_DIR === undefined
    ? join(homedir(), '.kiro', 'tdai-memory')
    : env.TDAI_MEMORY_STATE_DIR;

  return Object.freeze({
    gatewayUrl,
    apiKey,
    serviceId,
    teamId: env.TDAI_MEMORY_TEAM_ID ?? 'default',
    agentId: env.TDAI_MEMORY_AGENT_ID ?? 'kiro',
    userId,
    recallEnabled: readBoolean(env, 'TDAI_MEMORY_RECALL_ENABLED', true),
    captureEnabled: readBoolean(env, 'TDAI_MEMORY_CAPTURE_ENABLED', true),
    timeoutMs: readInteger(env, 'TDAI_MEMORY_TIMEOUT_MS', 2500, 1, 3000),
    maxRecallResults: readInteger(env, 'TDAI_MEMORY_MAX_RECALL_RESULTS', 5, 1, 100),
    maxContextChars: readInteger(env, 'TDAI_MEMORY_MAX_CONTEXT_CHARS', 6000, 512),
    stateDir,
    logLevel,
    enableConversationRecall: readBoolean(env, 'TDAI_MEMORY_CONVERSATION_RECALL_ENABLED', false),
  });
}

export function normalizeRecallConfig(config = {}) {
  const conversationRecallEnabled = typeof config.conversationRecallEnabled === 'boolean'
    ? config.conversationRecallEnabled
    : config.enableConversationRecall === true;
  return Object.freeze({ ...config, conversationRecallEnabled });
}

const defaults = (home) => ({
  teamId: 'default',
  agentId: 'kiro',
  stateDir: join(home, '.kiro', 'tdai-memory'),
  recallEnabled: true,
  captureEnabled: true,
  conversationRecallEnabled: true,
  skillRecallEnabled: true,
  timeoutMs: 2500,
  maxRecallResults: 5,
  maxContextChars: 6000,
  mcpMaxOutputChars: 12000,
  logLevel: 'warn',
});

const envFields = {
  gatewayUrl: 'TDAI_MEMORY_GATEWAY_URL',
  serviceId: 'TDAI_MEMORY_SERVICE_ID',
  teamId: 'TDAI_MEMORY_TEAM_ID',
  agentId: 'TDAI_MEMORY_AGENT_ID',
  userId: 'TDAI_MEMORY_USER_ID',
  stateDir: 'TDAI_MEMORY_STATE_DIR',
  recallEnabled: 'TDAI_MEMORY_RECALL_ENABLED',
  captureEnabled: 'TDAI_MEMORY_CAPTURE_ENABLED',
  conversationRecallEnabled: 'TDAI_MEMORY_CONVERSATION_RECALL_ENABLED',
  skillRecallEnabled: 'TDAI_MEMORY_SKILL_RECALL_ENABLED',
  timeoutMs: 'TDAI_MEMORY_TIMEOUT_MS',
  maxRecallResults: 'TDAI_MEMORY_MAX_RECALL_RESULTS',
  maxContextChars: 'TDAI_MEMORY_MAX_CONTEXT_CHARS',
  mcpMaxOutputChars: 'TDAI_MEMORY_MCP_MAX_OUTPUT_CHARS',
  logLevel: 'TDAI_MEMORY_LOG_LEVEL',
};

const booleanFields = new Set(['recallEnabled', 'captureEnabled', 'conversationRecallEnabled', 'skillRecallEnabled']);
const integerRanges = {
  timeoutMs: [1, 3000],
  maxRecallResults: [1, 100],
  maxContextChars: [512, 32000],
  mcpMaxOutputChars: [512, 32000],
};

const parseEnvironment = (env) => {
  const layer = {};
  for (const [field, name] of Object.entries(envFields)) {
    if (env[name] === undefined) continue;
    const value = env[name];
    if (booleanFields.has(field)) {
      if (typeof value !== 'string' || !['true', 'false'].includes(value.toLowerCase())) {
        throw safeError(field, 'environment', 'invalid_boolean');
      }
      layer[field] = value.toLowerCase() === 'true';
    } else if (Object.hasOwn(integerRanges, field)) {
      const parsed = typeof value === 'string' && value.trim() ? Number(value) : NaN;
      if (!Number.isInteger(parsed)) throw safeError(field, 'environment', 'invalid_integer');
      layer[field] = parsed;
    } else {
      layer[field] = value;
    }
  }
  return layer;
};

const validateRuntime = (config, provenance) => {
  for (const field of ['gatewayUrl', 'serviceId', 'userId']) {
    if (typeof config[field] !== 'string' || config[field].trim().length === 0) {
      throw safeError(field, provenance[field] ?? 'default', 'required');
    }
  }
  let url;
  try { url = new URL(config.gatewayUrl); } catch { throw safeError('gatewayUrl', provenance.gatewayUrl, 'invalid_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw safeError('gatewayUrl', provenance.gatewayUrl, 'invalid_url');
  }
  config.gatewayUrl = config.gatewayUrl.replace(/\/+$/, '');
  for (const field of ['teamId', 'agentId']) {
    if (typeof config[field] !== 'string' || config[field].length === 0 || config[field].includes('|')) {
      throw safeError(field, provenance[field], 'invalid_identifier');
    }
  }
  for (const field of booleanFields) {
    if (typeof config[field] !== 'boolean') throw safeError(field, provenance[field], 'invalid_boolean');
  }
  for (const [field, [minimum, maximum]] of Object.entries(integerRanges)) {
    if (!Number.isInteger(config[field]) || config[field] < minimum || config[field] > maximum) {
      throw safeError(field, provenance[field], 'out_of_range');
    }
  }
  if (!isAbsolute(config.stateDir)) throw safeError('stateDir', provenance.stateDir, 'not_absolute');
  if (!new Set(['error', 'warn', 'info', 'debug']).has(config.logLevel)) {
    throw safeError('logLevel', provenance.logLevel, 'invalid_enum');
  }
};

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export async function resolveConfig({ env = process.env, workspace = process.cwd(), homedir = defaultHomedir(), readFile } = {}) {
  const workspacePath = resolve(workspace);
  const homePath = typeof homedir === 'function' ? homedir() : homedir;
  const user = await readConfigLayer(join(homePath, '.kiro', 'settings', 'tdai-memory.json'), 'user', { readFile, error: safeError });
  const project = await readConfigLayer(join(workspacePath, '.kiro', 'settings', 'tdai-memory.json'), 'project', { readFile, error: safeError });
  const environment = parseEnvironment(env);
  const config = {};
  const provenance = {};
  const layers = [['default', defaults(homePath)], ['user', user ?? {}], ['project', project ?? {}], ['environment', environment]];
  for (const [source, layer] of layers) {
    for (const [field, value] of Object.entries(layer)) {
      config[field] = value;
      provenance[field] = source;
    }
  }
  validateRuntime(config, provenance);
  config.apiKey = typeof env.TDAI_MEMORY_API_KEY === 'string' && env.TDAI_MEMORY_API_KEY.length > 0
    ? env.TDAI_MEMORY_API_KEY
    : undefined;
  return deepFreeze({ config, provenance });
}
