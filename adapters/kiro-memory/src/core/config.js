import { homedir as defaultHomedir } from 'node:os';
import { join } from 'node:path';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

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
