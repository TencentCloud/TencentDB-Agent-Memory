import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("Usage: generate-config.mjs <install-root>");
const bool = (value, fallback = true) => value === undefined ? fallback : !["0", "false", "no", "off"].includes(value.toLowerCase());
const int = (value, fallback) => Number.parseInt(value ?? String(fallback), 10);
const env = process.env;
const configDir = join(root, "config");
const dataDir = join(root, "data");
const logDir = join(root, "logs");
const runDir = join(root, "run");
const appDir = join(root, "app");
for (const directory of [configDir, dataDir, logDir, runDir, join(dataDir, "core"), join(dataDir, "knowledge"), join(dataDir, "knowledge", "ssh-keys"), join(dataDir, "knowledge", "agent-templates"), join(dataDir, "proxy"), join(dataDir, "skill-resources")]) {
  mkdirSync(directory, { recursive: true });
}
const deploymentMode = (env.DEPLOYMENT_MODE || "basic").toLowerCase();
if (!["full", "basic"].includes(deploymentMode)) throw new Error("DEPLOYMENT_MODE must be full or basic.");
const coreProtocol = env.CORE_LLM_PROTOCOL || "openai";
if (!["openai", "anthropic"].includes(coreProtocol)) throw new Error("CORE_LLM_PROTOCOL must be openai or anthropic.");
const upstream = new URL(env.PROXY_UPSTREAM_URL || "http://127.0.0.1:18096");
if (!["http:", "https:"].includes(upstream.protocol)) throw new Error("PROXY_UPSTREAM_URL must be HTTP(S).");
if (deploymentMode === "full") {
  if (!env.CORE_LLM_BASE_URL || !env.CORE_LLM_API_KEY || !env.CORE_LLM_MODEL) {
    throw new Error("Full mode requires CORE_LLM_BASE_URL, CORE_LLM_API_KEY, and CORE_LLM_MODEL.");
  }
  if (!env.PROXY_UPSTREAM_API_KEY || !env.PROXY_UPSTREAM_MODEL) {
    throw new Error("Full mode requires PROXY_UPSTREAM_API_KEY and PROXY_UPSTREAM_MODEL.");
  }
  const coreUpstream = new URL(env.CORE_LLM_BASE_URL);
  if (!["http:", "https:"].includes(coreUpstream.protocol)) throw new Error("CORE_LLM_BASE_URL must be HTTP(S).");
  if ([upstream.hostname, coreUpstream.hostname].includes("llm-upstream.example.com")) {
    throw new Error("Replace the example LLM endpoints in settings.env before installation.");
  }
}
const adminKeyFile = join(configDir, "admin.key");
let adminKey;
if (existsSync(adminKeyFile) && readFileSync(adminKeyFile, "utf8").trim()) {
  adminKey = readFileSync(adminKeyFile, "utf8").trim();
} else {
  adminKey = `sk-mem-${randomBytes(48).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 32)}`;
  writeFileSync(adminKeyFile, adminKey, { mode: 0o600 });
}
chmodSync(adminKeyFile, 0o600);
writeFileSync(join(configDir, "proxy-upstream.key"), env.PROXY_UPSTREAM_API_KEY || "", { mode: 0o600 });
const extraction = bool(env.CORE_ENABLE_EXTRACTION, deploymentMode === "full");
const core = {
  deployMode: "standalone",
  stateBackend: "local",
  server: { port: int(env.CORE_PORT, 8420), host: env.CORE_HOST || "0.0.0.0" },
  data: { baseDir: join(dataDir, "core") },
  llm: { baseUrl: env.CORE_LLM_BASE_URL || "", apiKey: env.CORE_LLM_API_KEY || "", model: env.CORE_LLM_MODEL || "", maxTokens: 32000, timeoutMs: 300000 },
  memory: {
    promptMode: env.CORE_PROMPT_MODE || "code",
    capture: { enabled: true },
    extraction: { enabled: extraction, enableDedup: true, maxMemoriesPerSession: 20 },
    persona: { triggerEveryN: 50, maxScenes: 15, triggerMode: "current" },
    pipeline: { everyNConversations: 5, enableWarmup: extraction, l1IdleTimeoutSeconds: 600, l2DelayAfterL1Seconds: 90, l2MinIntervalSeconds: 900, l2MaxIntervalSeconds: 3600 },
    recall: { enabled: true, maxResults: 5, scoreThreshold: 0.3, strategy: "hybrid", timeoutMs: 5000 },
    storeBackend: "sqlite",
    embedding: { provider: "none" },
  },
  skill: {
    enabled: true,
    routing: { mode: "bm25", searchTopK: 20 },
    extraction: { enabled: extraction, maxIterations: 16, queue: { backend: "local", keyPrefix: "tdai", resultTtlSeconds: 86400, lockTtlMs: 600000, maxRetries: 2, retryBackoffsMs: [5000, 15000] } },
    resources: { maxResourceSizeBytes: 5000000, downloadDir: join(dataDir, "skill-resources") },
  },
};
const corePort = int(env.CORE_PORT, 8420);
const knowledgePort = int(env.KNOWLEDGE_PORT, 8424);
const panelPort = int(env.PANEL_PORT, 8125);
const proxyPort = int(env.PROXY_PORT, 8096);
const proxy = {
  server: { host: env.PROXY_HOST || "0.0.0.0", port: proxyPort, forwardTimeoutMs: 600000 },
  upstream: { url: upstream.toString(), apiKey: "" },
  log: { file: "", level: "info", backend: "console" },
  tdai: { enabled: bool(env.PROXY_ENABLE_TDAI), endpoint: `http://127.0.0.1:${corePort}`, apiKey: "", serviceId: "default", memory: { enabled: true, inject: true, writeL0: true, recallL1: true, injectL2L3: true } },
  skill: { endpoint: `http://127.0.0.1:${corePort}`, serviceToken: "" },
  knowledge: { enabled: bool(env.PROXY_ENABLE_TDAI), endpoint: `http://127.0.0.1:${corePort}`, serviceToken: "", serviceId: "default" },
  auth: { enabled: bool(env.PROXY_ENABLE_AUTH), url: `http://127.0.0.1:${corePort}`, timeoutMs: 5000 },
  sessionInit: { enabled: bool(env.PROXY_ENABLE_SESSION_INIT, false), maxRetries: 3, injectAgentContext: true, injectTaskContext: true, headerAutoSelect: { enabled: true, teamHeader: "x-team-id", agentHeader: "x-agent-id", taskHeader: "x-task-id", onMismatch: "form" } },
  costGuard: { enabled: false },
  creditReport: { url: "", timeoutMs: 5000 },
  injection: { enabled: true, injectors: ["skill", "knowledge", "tdai-memory"] },
  redis: { enabled: false },
  storage: { enabled: true, backend: "sqlite", ttlDays: 7, sqlite: { dbPath: join(dataDir, "proxy", "proxy.db") }, fs: { fsRoot: join(dataDir, "proxy", "fs") } },
};
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
writeJson(join(configDir, "tdai-gateway.yaml"), core);
writeJson(join(configDir, "proxy.yaml"), proxy);
writeJson(join(configDir, "metadata-instances.json"), { instances: [{ id: env.PANEL_INSTANCE_ID || "default", name: env.PANEL_INSTANCE_NAME || "Local Linux", gateway_endpoint: `http://127.0.0.1:${corePort}`, proxy_endpoint: `http://127.0.0.1:${proxyPort}`, api_key: adminKey }] });
const environment = {
  Core: { NODE_ENV: "production", TDAI_GATEWAY_CONFIG: join(configDir, "tdai-gateway.yaml"), TDAI_GATEWAY_HOST: env.CORE_HOST || "0.0.0.0", TDAI_GATEWAY_PORT: String(corePort), TDAI_GATEWAY_API_KEY: "", TDAI_DATA_DIR: join(dataDir, "core"), STORE_MODE: "sqlite" },
  Knowledge: { HOST: env.KNOWLEDGE_HOST || "0.0.0.0", PORT: String(knowledgePort), API_PREFIX: "/v3", KNOWLEDGE_DATA_DIR: join(dataDir, "knowledge"), KNOWLEDGE_DB_PATH: join(dataDir, "knowledge", "knowledge.db"), KNOWLEDGE_SSH_KEY_DIR: join(dataDir, "knowledge", "ssh-keys"), KNOWLEDGE_PUBLIC_BASE_URL: `http://127.0.0.1:${knowledgePort}/v3`, KNOWLEDGE_SERVICE_KEY: "", TDAI_AGENT_TEMPLATE_DIR: join(dataDir, "knowledge", "agent-templates"), TMC_CALLBACK_URL: `http://127.0.0.1:${panelPort}`, LLM_MODE: "custom", LLM_PROVIDER: "custom", LLM_PROTOCOL: coreProtocol, LLM_API_KEY: env.CORE_LLM_API_KEY || "", LLM_BASE_URL: env.CORE_LLM_BASE_URL || "", LLM_MODEL: env.CORE_LLM_MODEL || "", LLM_MAX_TOKENS: "32768", LLM_TIMEOUT_MS: "1200000", LOG_LEVEL: "info" },
  Panel: { HOST: env.PANEL_HOST || "0.0.0.0", PORT: String(panelPort), UI_DIST_DIR: join(appDir, "MemoryPanel", "web", "dist"), METADATA_INSTANCES_CONFIG: join(configDir, "metadata-instances.json"), METADATA_REMOTE_TIMEOUT_MS: "15000", KNOWLEDGE_SERVICE_URL: `http://127.0.0.1:${knowledgePort}`, KNOWLEDGE_AUTH_TOKEN: "", KNOWLEDGE_TIMEOUT_MS: "15000", KNOWLEDGE_LLM_BINDING_SYNC: "0", LOG_LEVEL: "info", LOG_FORMAT: "json" },
  Proxy: { TDAI_PROXY_UPSTREAM_API_KEY_FILE: join(configDir, "proxy-upstream.key") },
};
writeJson(join(configDir, "environment.json"), environment);
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
for (const [name, values] of Object.entries(environment)) {
  const content = Object.entries(values).map(([key, value]) => `${key}=${shellQuote(value)}`).join("\n") + "\n";
  writeFileSync(join(configDir, `${name.toLowerCase()}.env`), content, { mode: 0o600 });
}
console.log(`Native configuration generated in ${configDir}`);
