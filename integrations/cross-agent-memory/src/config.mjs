import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const DEFAULT_ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid config: ${field} is required`);
  }
  return value.trim();
}

function optionalPositiveInteger(value, field, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid config: ${field} must be a positive integer`);
  }
  return value;
}

function optionalObject(value, field) {
  if (value === undefined) {
    return {};
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid config: ${field} must be an object`);
  }
  return value;
}

function normalizeEndpoint(endpoint, field = "endpoint") {
  const normalized = endpoint.replace(/\/+$/, "");
  try {
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new Error(`Invalid config: ${field} must be an HTTP(S) URL`);
  }
  return normalized;
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return Object.freeze(value);
}

export async function loadConfig(rootDir = DEFAULT_ROOT_DIR) {
  const configPath = join(rootDir, "config.local.json");
  let source;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Missing required config.local.json");
    }
    throw new Error("Unable to read config.local.json");
  }

  let rawConfig;
  try {
    rawConfig = JSON.parse(source);
  } catch {
    throw new Error("Invalid config.local.json");
  }

  const config = optionalObject(rawConfig, "root");
  const identity = optionalObject(config.identity, "identity");
  const timeouts = optionalObject(config.timeouts, "timeouts");
  const recall = optionalObject(config.recall, "recall");
  const queue = optionalObject(config.queue, "queue");

  const normalizedConfig = {
    endpoint: normalizeEndpoint(requiredString(config.endpoint, "endpoint")),
    hubEndpoint: normalizeEndpoint(
      config.hubEndpoint === undefined
        ? "http://127.0.0.1:8125"
        : requiredString(config.hubEndpoint, "hubEndpoint"),
      "hubEndpoint"
    ),
    apiKey: requiredString(config.apiKey, "apiKey"),
    serviceId: requiredString(config.serviceId, "serviceId"),
    identity: {
      teamId: requiredString(identity.teamId, "identity.teamId"),
      agentId: requiredString(identity.agentId, "identity.agentId"),
      userId: requiredString(identity.userId, "identity.userId"),
      taskId: requiredString(identity.taskId, "identity.taskId")
    },
    timeouts: {
      recallMs: optionalPositiveInteger(timeouts.recallMs, "timeouts.recallMs", 1200),
      captureMs: optionalPositiveInteger(timeouts.captureMs, "timeouts.captureMs", 3000)
    },
    recall: {
      l0Limit: optionalPositiveInteger(recall.l0Limit, "recall.l0Limit", 3),
      l1Limit: optionalPositiveInteger(recall.l1Limit, "recall.l1Limit", 5),
      maxContextChars: optionalPositiveInteger(recall.maxContextChars, "recall.maxContextChars", 12000)
    },
    queue: {
      retryBatchSize: Math.min(optionalPositiveInteger(queue.retryBatchSize, "queue.retryBatchSize", 3), 3),
      retryBudgetMs: optionalPositiveInteger(queue.retryBudgetMs, "queue.retryBudgetMs", 800)
    }
  };

  return deepFreeze(normalizedConfig);
}
