/** Config loading: YAML file → merge with CLI overrides → ProxyConfig. */

import { readFileSync } from "node:fs";
import { load as yamlLoad } from "js-yaml";
import type { CostGuardConfig, ProxyConfig, RawYamlConfig } from "./types.js";

const DEFAULT_UPSTREAM = "https://llm-upstream.example.com/v2/chat/completions";

export const DEFAULT_CONFIG: ProxyConfig = {
  server: { host: "0.0.0.0", port: 8096, forwardTimeoutMs: 600_000 },
  upstream: { url: DEFAULT_UPSTREAM, apiKey: "", agents: {} },
  log: {
    file: "",
    verbose: false,
    level: "info",
    backend: "console",
    rotate: { maxSizeBytes: 100 * 1024 * 1024, backupLimit: 10 },
  },
  opik: { enabled: false, url: "", apiKey: "", stripRequestLogContent: false },
  langfuse: { enabled: false, host: "", publicKey: "", secretKey: "", debug: false },
  clickhouse: {
    enabled: false,
    url: "",
    database: "context_proxy",
    table: "usage_logs",
    rawTable: "usage_raw",
    user: "default",
    password: "",
    flushIntervalMs: 5000,
    flushThreshold: 50,
    ttlDays: 0,
  },
  redis: {
    enabled: false,
    url: "",
    host: "127.0.0.1",
    port: 6379,
    password: "",
    db: 0,
    keyPrefix: "cg:sess:",
    ttlSeconds: 1800,
  },
  rateLimit: {
    tpm: 1_000_000,
    qpm: 100,
  },
  storage: {
    enabled: false,
    backend: "sqlite",
    ttlDays: 7,
    cos: {
      rootPrefix: "proxy_cache/",
      shark: {
        baseUrl: "",
        timeoutMs: 10_000,
        retryCount: 2,
        refreshBufferMs: 2 * 60_000,
        maxSpaces: 100,
        graceCloseDelayMs: 30_000,
      },
    },
    sqlite: { dbPath: "" },
    fs: { fsRoot: "/var/lib/context-proxy/storage" },
  },
  costGuard: {
    enabled: false,
    markerOptIn: false,
    agentProfile: "auto",
    options: {},
  },
  creditReport: {
    url: "http://gateway.example.com:8000/UpdateMemoryPlusUsage",
    timeoutMs: 5000,
  },
  creditPricing: { models: [] },
  injection: {
    enabled: false,
    injectors: ["skill", "knowledge", "tdai-memory"],
    assetReflection: { markerOptIn: false },
  },
  // Extraction (write-side) defaults to fully permissive so that a config
  // without the `extraction:` block behaves identically to the pre-gate
  // behavior (skill extract + L0 write both on).
  extraction: {
    enabled: true,
    extractors: ["skill", "tdai-memory"],
  },
  sessionInit: {
    enabled: false,
    maxRetries: 3,
    injectAgentContext: true,
    injectTaskContext: true,
    headerAutoSelect: {
      enabled: true,
      teamHeader: "x-team-id",
      agentHeader: "x-agent-id",
      taskHeader: "x-task-id",
      onMismatch: "form",
    },
    // debugForceIdentity intentionally omitted — must be explicitly set in yaml
    // to activate the bypass path.
  },
  tdai: {
    enabled: false,
    endpoint: "",
    apiKey: "local-proxy",
    serviceId: "default",
    memory: {
      enabled: false,
      inject: false,
      writeL0: false,
      recallL1: false,
      injectL2L3: false,
      l1Limit: 5,
      l2Limit: 3,
      timeoutMs: 3000,
    },
  },
  coreSkill: {
    endpoint: "http://127.0.0.1:8420",
    serviceToken: "",
    serviceId: "context-proxy",
    timeoutMs: 1500,
  },
  knowledge: {
    enabled: false,
    endpoint: "http://127.0.0.1:8420",
    serviceToken: "",
    serviceId: "context-proxy",
    timeoutMs: 1500,
  },
  skillRuntime: {
    allowLlmWrite: false,
  },
  auth: {
    enabled: false,
    url: "",
    timeoutMs: 5000,
  },
  systemUsers: [],
  admin: { apiKey: "" },
  memCommand: { enabled: false, allowedCommands: [] },
  ccRequestRouting: { enabled: false },
  workbuddyRequestRouting: { enabled: true },
};

/** Load and parse a YAML config file. Returns empty object on missing file. */
export function loadYamlConfig(filePath: string): RawYamlConfig {
  try {
    const text = readFileSync(filePath, "utf-8");
    const parsed = yamlLoad(text);
    if (parsed == null || typeof parsed !== "object") {
      // eslint-disable-next-line no-console
      console.warn(
        `[config] ${filePath} parsed to empty/invalid YAML — falling back to DEFAULT_CONFIG. ` +
          `This means sessionInit/injection/tdai/etc. will use hard-coded defaults (mostly disabled).`,
      );
      return {};
    }
    // eslint-disable-next-line no-console
    console.log(
      `[config] loaded ${filePath} (top-level sections: ${Object.keys(parsed as object).join(",")})`,
    );
    return parsed as RawYamlConfig;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      // eslint-disable-next-line no-console
      console.warn(
        `[config] ${filePath} not found (cwd=${process.cwd()}) — falling back to DEFAULT_CONFIG. ` +
          `sessionInit/injection/tdai/etc. will use hard-coded defaults (mostly disabled). ` +
          `Pass --config /absolute/path/to/config.yaml if the file is elsewhere.`,
      );
      return {};
    }
    throw err;
  }
}

/** CLI override options (all optional). */
export interface CliOverrides {
  configFile?: string;
  host?: string;
  port?: number;
  upstreamUrl?: string;
  logFile?: string;
  opikEnabled?: boolean;
  opikUrl?: string;
  opikApiKey?: string;
  verbose?: boolean;
}

/**
 * Parse the optional private forwarding extension config.
 *
 * The host only reads the generic fields (`enabled`, `agentProfile`,
 * `anthropicUpstream`); every other key is kept opaque in `options` and handed
 * to the extension untouched. The legacy top-level `badcaseCollector` block, if
 * present, is folded into `options` without being interpreted.
 */
function parseCostGuard(yaml: RawYamlConfig): CostGuardConfig {
  const raw: Record<string, unknown> = { ...(yaml.costGuard ?? {}) };
  const enabled = raw.enabled;
  const markerOptIn = raw.markerOptIn;
  const agentProfile = raw.agentProfile;
  const anthropicUpstream = raw.anthropicUpstream;

  // Everything else is opaque private options — never parsed by the host.
  delete raw.enabled;
  delete raw.markerOptIn;
  delete raw.agentProfile;
  delete raw.anthropicUpstream;
  const options: Record<string, unknown> = raw;
  if (yaml.badcaseCollector !== undefined) {
    options.badcaseCollector = yaml.badcaseCollector;
  }

  const result: CostGuardConfig = {
    enabled: typeof enabled === "boolean" ? enabled : DEFAULT_CONFIG.costGuard.enabled,
    markerOptIn: typeof markerOptIn === "boolean" ? markerOptIn : DEFAULT_CONFIG.costGuard.markerOptIn,
    agentProfile: typeof agentProfile === "string" ? agentProfile : DEFAULT_CONFIG.costGuard.agentProfile,
    options,
  };
  if (
    anthropicUpstream &&
    typeof anthropicUpstream === "object" &&
    typeof (anthropicUpstream as { url?: unknown }).url === "string"
  ) {
    result.anthropicUpstream = { url: (anthropicUpstream as { url: string }).url };
  }
  return result;
}

/**
 * Parse `upstream.agents` from raw YAML into the normalized `AgentUpstreamEntry`
 * map. Entries without a non-empty `url` are silently dropped — an empty url
 * would just fall back to the global upstream, so keeping the entry adds only
 * noise (and would make "did I configure this right?" harder to answer at
 * a glance).
 */
function parseUpstreamAgents(
  raw: Record<string, { url?: string; apiKey?: string } | null | undefined> | undefined,
): Record<string, { url: string; apiKey?: string }> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, { url: string; apiKey?: string }> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    const url = (entry as { url?: unknown }).url;
    if (typeof url !== "string" || url.length === 0) continue;
    const apiKey = (entry as { apiKey?: unknown }).apiKey;
    out[name] = typeof apiKey === "string" && apiKey.length > 0
      ? { url, apiKey }
      : { url };
  }
  return out;
}

/**
 * Build the final ProxyConfig.
 * Priority (high → low): CLI overrides > YAML config file > defaults.
 */
export function buildConfig(overrides: CliOverrides = {}): ProxyConfig {
  const configPath = overrides.configFile || "config.yaml";
  const yaml = loadYamlConfig(configPath);

  return {
    server: {
      host: overrides.host ?? yaml.server?.host ?? DEFAULT_CONFIG.server.host,
      port: overrides.port ?? yaml.server?.port ?? DEFAULT_CONFIG.server.port,
      forwardTimeoutMs:
        yaml.server?.forwardTimeoutMs ??
        DEFAULT_CONFIG.server.forwardTimeoutMs,
    },
    upstream: {
      url:
        overrides.upstreamUrl ??
        yaml.upstream?.url ??
        DEFAULT_CONFIG.upstream.url,
      apiKey: yaml.upstream?.apiKey ?? DEFAULT_CONFIG.upstream.apiKey,
      agents: parseUpstreamAgents(yaml.upstream?.agents),
    },
    log: {
      file: overrides.logFile ?? yaml.log?.file ?? DEFAULT_CONFIG.log.file,
      verbose:
        overrides.verbose ?? yaml.log?.verbose ?? DEFAULT_CONFIG.log.verbose,
      level: yaml.log?.level ?? DEFAULT_CONFIG.log.level,
      backend: yaml.log?.backend ?? DEFAULT_CONFIG.log.backend,
      rotate: {
        maxSizeBytes:
          yaml.log?.rotate?.maxSizeBytes ?? DEFAULT_CONFIG.log.rotate.maxSizeBytes,
        backupLimit:
          yaml.log?.rotate?.backupLimit ?? DEFAULT_CONFIG.log.rotate.backupLimit,
      },
    },
    opik: {
      enabled:
        overrides.opikEnabled ??
        yaml.opik?.enabled ??
        DEFAULT_CONFIG.opik.enabled,
      url: overrides.opikUrl ?? yaml.opik?.url ?? DEFAULT_CONFIG.opik.url,
      apiKey:
        overrides.opikApiKey ?? yaml.opik?.apiKey ?? DEFAULT_CONFIG.opik.apiKey,
      stripRequestLogContent:
        yaml.opik?.stripRequestLogContent ?? DEFAULT_CONFIG.opik.stripRequestLogContent,
    },
    langfuse: {
      enabled: yaml.langfuse?.enabled ?? DEFAULT_CONFIG.langfuse.enabled,
      host: yaml.langfuse?.host ?? DEFAULT_CONFIG.langfuse.host,
      publicKey: yaml.langfuse?.publicKey ?? DEFAULT_CONFIG.langfuse.publicKey,
      secretKey: yaml.langfuse?.secretKey ?? DEFAULT_CONFIG.langfuse.secretKey,
      debug: yaml.langfuse?.debug ?? DEFAULT_CONFIG.langfuse.debug,
    },
    clickhouse: {
      enabled: yaml.clickhouse?.enabled ?? DEFAULT_CONFIG.clickhouse.enabled,
      url: yaml.clickhouse?.url ?? DEFAULT_CONFIG.clickhouse.url,
      database: yaml.clickhouse?.database ?? DEFAULT_CONFIG.clickhouse.database,
      table: yaml.clickhouse?.table ?? DEFAULT_CONFIG.clickhouse.table,
      rawTable: yaml.clickhouse?.rawTable ?? DEFAULT_CONFIG.clickhouse.rawTable,
      user: yaml.clickhouse?.user ?? DEFAULT_CONFIG.clickhouse.user,
      password: yaml.clickhouse?.password ?? DEFAULT_CONFIG.clickhouse.password,
      flushIntervalMs: yaml.clickhouse?.flushIntervalMs ?? DEFAULT_CONFIG.clickhouse.flushIntervalMs,
      flushThreshold: yaml.clickhouse?.flushThreshold ?? DEFAULT_CONFIG.clickhouse.flushThreshold,
      ttlDays: yaml.clickhouse?.ttlDays ?? DEFAULT_CONFIG.clickhouse.ttlDays,
    },
    redis: {
      enabled: yaml.redis?.enabled ?? DEFAULT_CONFIG.redis.enabled,
      url: yaml.redis?.url ?? DEFAULT_CONFIG.redis.url,
      host: yaml.redis?.host ?? DEFAULT_CONFIG.redis.host,
      port: yaml.redis?.port ?? DEFAULT_CONFIG.redis.port,
      password: yaml.redis?.password ?? DEFAULT_CONFIG.redis.password,
      db: yaml.redis?.db ?? DEFAULT_CONFIG.redis.db,
      keyPrefix: yaml.redis?.keyPrefix ?? DEFAULT_CONFIG.redis.keyPrefix,
      ttlSeconds: yaml.redis?.ttlSeconds ?? DEFAULT_CONFIG.redis.ttlSeconds,
      injectionTtlSeconds: yaml.redis?.injectionTtlSeconds ?? DEFAULT_CONFIG.redis.injectionTtlSeconds,
    },
    rateLimit: {
      tpm: Math.max(0, yaml.rateLimit?.tpm ?? DEFAULT_CONFIG.rateLimit.tpm),
      qpm: Math.max(0, yaml.rateLimit?.qpm ?? DEFAULT_CONFIG.rateLimit.qpm),
    },
    storage: {
      enabled: yaml.storage?.enabled ?? DEFAULT_CONFIG.storage.enabled,
      backend: yaml.storage?.backend ?? DEFAULT_CONFIG.storage.backend,
      ttlDays: yaml.storage?.ttlDays ?? DEFAULT_CONFIG.storage.ttlDays,
      cos: {
        rootPrefix: yaml.storage?.cos?.rootPrefix ?? DEFAULT_CONFIG.storage.cos.rootPrefix,
        endpointDomain: yaml.storage?.cos?.endpointDomain ?? undefined,
        shark: {
          baseUrl: yaml.storage?.cos?.shark?.baseUrl ?? DEFAULT_CONFIG.storage.cos.shark.baseUrl,
          timeoutMs: yaml.storage?.cos?.shark?.timeoutMs ?? DEFAULT_CONFIG.storage.cos.shark.timeoutMs,
          retryCount: yaml.storage?.cos?.shark?.retryCount ?? DEFAULT_CONFIG.storage.cos.shark.retryCount,
          refreshBufferMs: yaml.storage?.cos?.shark?.refreshBufferMs ?? DEFAULT_CONFIG.storage.cos.shark.refreshBufferMs,
          maxSpaces: yaml.storage?.cos?.shark?.maxSpaces ?? DEFAULT_CONFIG.storage.cos.shark.maxSpaces,
          graceCloseDelayMs: yaml.storage?.cos?.shark?.graceCloseDelayMs ?? DEFAULT_CONFIG.storage.cos.shark.graceCloseDelayMs,
        },
      },
      sqlite: { dbPath: yaml.storage?.sqlite?.dbPath ?? DEFAULT_CONFIG.storage.sqlite.dbPath },
      fs: { fsRoot: yaml.storage?.fs?.fsRoot ?? DEFAULT_CONFIG.storage.fs.fsRoot },
    },
    costGuard: parseCostGuard(yaml),
    creditReport: {
      url: yaml.creditReport?.url ?? DEFAULT_CONFIG.creditReport.url,
      timeoutMs: yaml.creditReport?.timeoutMs ?? DEFAULT_CONFIG.creditReport.timeoutMs,
    },
    creditPricing: {
      models: (yaml.creditPricing?.models ?? []).map((m) => ({
        name: m.name ?? "",
        // Display name / alias — 显式加载。缺失时 `resolveModelName` 回落 `name`，
        // 但 `resolveModelId` 依赖此字段做 client-facing alias → real model_id 反查
        // （§13.15），漏加载会让 alias 永远查不到，客户端发 alias 直接 400。
        modelName: m.modelName,
        input: m.input ?? 0,
        output: m.output ?? 0,
        cacheRead: m.cacheRead ?? 0,
        cacheWrite5m: m.cacheWrite5m ?? 0,
        cacheWrite1h: m.cacheWrite1h ?? 0,
      })).filter((m) => m.name !== ""),
    },
    injection: {
      enabled: yaml.injection?.enabled ?? DEFAULT_CONFIG.injection.enabled,
      injectors: yaml.injection?.injectors ?? DEFAULT_CONFIG.injection.injectors,
      externalGatewayUrl: typeof yaml.injection?.externalGatewayUrl === "string" && yaml.injection.externalGatewayUrl.trim() !== ""
        ? yaml.injection.externalGatewayUrl.trim().replace(/\/$/, "")
        : undefined,
      // 只接受 boolean；yaml 缺省或类型错走 default（关）。跟 costGuard.markerOptIn
      // 同姿势，保证线上未配 assetReflection: 段的 yaml 完全无感。
      assetReflection: {
        markerOptIn: typeof yaml.injection?.assetReflection?.markerOptIn === "boolean"
          ? yaml.injection.assetReflection.markerOptIn
          : DEFAULT_CONFIG.injection.assetReflection!.markerOptIn,
      },
    },
    extraction: {
      enabled: yaml.extraction?.enabled ?? DEFAULT_CONFIG.extraction.enabled,
      extractors: yaml.extraction?.extractors ?? DEFAULT_CONFIG.extraction.extractors,
    },
  sessionInit: {
    enabled: yaml.sessionInit?.enabled ?? DEFAULT_CONFIG.sessionInit.enabled,
    maxRetries: yaml.sessionInit?.maxRetries ?? DEFAULT_CONFIG.sessionInit.maxRetries,
    injectAgentContext: yaml.sessionInit?.injectAgentContext ?? DEFAULT_CONFIG.sessionInit.injectAgentContext,
    injectTaskContext: yaml.sessionInit?.injectTaskContext ?? DEFAULT_CONFIG.sessionInit.injectTaskContext,
    defaultTaskId: typeof yaml.sessionInit?.defaultTaskId === "string" && yaml.sessionInit.defaultTaskId.trim()
      ? yaml.sessionInit.defaultTaskId.trim()
      : undefined,
    headerAutoSelect: {
      enabled: yaml.sessionInit?.headerAutoSelect?.enabled ?? DEFAULT_CONFIG.sessionInit.headerAutoSelect!.enabled,
      teamHeader: (yaml.sessionInit?.headerAutoSelect?.teamHeader ?? DEFAULT_CONFIG.sessionInit.headerAutoSelect!.teamHeader).toLowerCase(),
      agentHeader: (yaml.sessionInit?.headerAutoSelect?.agentHeader ?? DEFAULT_CONFIG.sessionInit.headerAutoSelect!.agentHeader).toLowerCase(),
      taskHeader: (yaml.sessionInit?.headerAutoSelect?.taskHeader ?? DEFAULT_CONFIG.sessionInit.headerAutoSelect!.taskHeader).toLowerCase(),
      onMismatch: yaml.sessionInit?.headerAutoSelect?.onMismatch ?? DEFAULT_CONFIG.sessionInit.headerAutoSelect!.onMismatch,
    },
    debugForceIdentity: yaml.sessionInit?.debugForceIdentity
      && typeof yaml.sessionInit.debugForceIdentity === "object"
      && typeof (yaml.sessionInit.debugForceIdentity as Record<string, unknown>).team_id === "string"
      && typeof (yaml.sessionInit.debugForceIdentity as Record<string, unknown>).agent_id === "string"
      ? {
          team_id: (yaml.sessionInit.debugForceIdentity as Record<string, string>).team_id,
          agent_id: (yaml.sessionInit.debugForceIdentity as Record<string, string>).agent_id,
          task_id: typeof (yaml.sessionInit.debugForceIdentity as Record<string, unknown>).task_id === "string"
            ? (yaml.sessionInit.debugForceIdentity as Record<string, string>).task_id
            : undefined,
        }
      : undefined,
    debugForceUserId: typeof yaml.sessionInit?.debugForceUserId === "string"
      && yaml.sessionInit.debugForceUserId.trim()
      ? yaml.sessionInit.debugForceUserId.trim()
      : undefined,
    debugVerboseLogging: yaml.sessionInit?.debugVerboseLogging ?? false,
  },
    tdai: {
      enabled: yaml.tdai?.enabled ?? DEFAULT_CONFIG.tdai.enabled,
      endpoint: yaml.tdai?.endpoint ?? DEFAULT_CONFIG.tdai.endpoint,
      apiKey: yaml.tdai?.apiKey ?? DEFAULT_CONFIG.tdai.apiKey,
      serviceId: yaml.tdai?.serviceId ?? DEFAULT_CONFIG.tdai.serviceId,
      memory: {
        enabled: yaml.tdai?.memory?.enabled ?? DEFAULT_CONFIG.tdai.memory.enabled,
        inject: yaml.tdai?.memory?.inject ?? DEFAULT_CONFIG.tdai.memory.inject,
        writeL0: yaml.tdai?.memory?.writeL0 ?? DEFAULT_CONFIG.tdai.memory.writeL0,
        recallL1: yaml.tdai?.memory?.recallL1 ?? DEFAULT_CONFIG.tdai.memory.recallL1,
        injectL2L3: yaml.tdai?.memory?.injectL2L3 ?? DEFAULT_CONFIG.tdai.memory.injectL2L3,
        l1Limit: yaml.tdai?.memory?.l1Limit ?? DEFAULT_CONFIG.tdai.memory.l1Limit,
        l2Limit: yaml.tdai?.memory?.l2Limit ?? DEFAULT_CONFIG.tdai.memory.l2Limit,
        timeoutMs: yaml.tdai?.memory?.timeoutMs ?? DEFAULT_CONFIG.tdai.memory.timeoutMs,
      },
    },
    // `skill:` is the canonical YAML section name; `coreSkill:` is kept as a
    // backward-compat alias so existing deployments don't break. Prefer the
    // new name in config.example.yaml. When both are present, `skill:` wins.
    coreSkill: {
      endpoint: yaml.skill?.endpoint ?? yaml.coreSkill?.endpoint ?? DEFAULT_CONFIG.coreSkill.endpoint,
      serviceToken: yaml.skill?.serviceToken ?? yaml.coreSkill?.serviceToken ?? DEFAULT_CONFIG.coreSkill.serviceToken,
      serviceId: yaml.skill?.serviceId ?? yaml.coreSkill?.serviceId ?? DEFAULT_CONFIG.coreSkill.serviceId,
      timeoutMs: yaml.skill?.timeoutMs ?? yaml.coreSkill?.timeoutMs ?? DEFAULT_CONFIG.coreSkill.timeoutMs,
    },
    knowledge: {
      enabled: yaml.knowledge?.enabled ?? DEFAULT_CONFIG.knowledge.enabled,
      endpoint: yaml.knowledge?.endpoint ?? DEFAULT_CONFIG.knowledge.endpoint,
      serviceToken: yaml.knowledge?.serviceToken ?? DEFAULT_CONFIG.knowledge.serviceToken,
      serviceId: yaml.knowledge?.serviceId ?? DEFAULT_CONFIG.knowledge.serviceId,
      timeoutMs: yaml.knowledge?.timeoutMs ?? DEFAULT_CONFIG.knowledge.timeoutMs,
    },
    skillRuntime: {
      allowLlmWrite:
        yaml.skillRuntime?.allowLlmWrite ??
        DEFAULT_CONFIG.skillRuntime.allowLlmWrite,
    },
    auth: {
      enabled: yaml.auth?.enabled ?? DEFAULT_CONFIG.auth.enabled,
      url: yaml.auth?.url ?? DEFAULT_CONFIG.auth.url,
      timeoutMs: yaml.auth?.timeoutMs ?? DEFAULT_CONFIG.auth.timeoutMs,
    },
    // Entries without a non-empty userId are silently dropped — matching is
    // by userId now, and an empty userId would otherwise collide with
    // `verifyUserKey` returning "" for unauthenticated / auth-disabled
    // requests (exactly the wrong direction of failure). `userKey` stayed
    // optional: it's kept as a log-only reference to the historical sk-mem
    // key and no longer influences matching.
    // `${VAR}` in string values is expanded from process.env at load time
    // so the yaml can reference secrets without hard-coding them.
    systemUsers: (yaml.systemUsers ?? [])
      .map((u) => ({
        name: expandEnv(u.name ?? "").trim(),
        userId: expandEnv(u.userId ?? "").trim(),
        displayName: expandEnv(u.displayName ?? "").trim(),
        userKey: expandEnv(u.userKey ?? "").trim(),
      }))
      .filter((u) => u.userId !== ""),
    admin: {
      // Precedence: env > yaml > default("")。跟 core `TDAI_GATEWAY_API_KEY`
      // 的运维习惯对齐；空字符串表示鉴权关闭（默认公开可访问，启动时告警）。
      apiKey:
        (process.env.TDAI_PROXY_ADMIN_API_KEY ?? "").trim() ||
        yaml.admin?.apiKey ||
        DEFAULT_CONFIG.admin.apiKey,
    },
    memCommand: {
      enabled: yaml.memCommand?.enabled ?? DEFAULT_CONFIG.memCommand.enabled,
      allowedCommands: Array.isArray(yaml.memCommand?.allowedCommands)
        ? yaml.memCommand.allowedCommands.filter((c: unknown) => typeof c === "string")
        : DEFAULT_CONFIG.memCommand.allowedCommands,
    },
    ccRequestRouting: {
      enabled:
        (yaml as { ccRequestRouting?: { enabled?: boolean } }).ccRequestRouting?.enabled
        ?? DEFAULT_CONFIG.ccRequestRouting.enabled,
    },
    workbuddyRequestRouting: {
      enabled:
        (yaml as { workbuddyRequestRouting?: { enabled?: boolean } }).workbuddyRequestRouting?.enabled
        ?? DEFAULT_CONFIG.workbuddyRequestRouting.enabled,
    },
  };
}

/**
 * Expand `${VAR}` / `${VAR:-default}` references in a string using
 * `process.env`. Missing vars with no default become an empty string.
 *
 * Deliberately scoped narrowly (only called from `systemUsers` today) to
 * avoid changing the semantics of other fields where a literal `${...}`
 * might already be in use (regex-adjacent config, prompts, etc).
 */
function expandEnv(input: string): string {
  return input.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/gi, (_m, name: string, def?: string) => {
    const val = process.env[name];
    if (val !== undefined && val !== "") return val;
    return def ?? "";
  });
}

/** Parse process.argv into CliOverrides (minimal arg parser, no extra deps). */
export function parseArgv(argv: string[]): CliOverrides {
  const overrides: CliOverrides = {};
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--config":
        overrides.configFile = next;
        i++;
        break;
      case "--host":
        overrides.host = next;
        i++;
        break;
      case "--port":
        overrides.port = Number(next);
        i++;
        break;
      case "--upstream":
        overrides.upstreamUrl = next;
        i++;
        break;
      case "--log-file":
        overrides.logFile = next;
        i++;
        break;
      case "--opik-url":
        overrides.opikUrl = next;
        i++;
        break;
      case "--opik-api-key":
        overrides.opikApiKey = next;
        i++;
        break;
      case "--opik-enabled":
        overrides.opikEnabled = true;
        break;
      case "--verbose":
      case "-v":
        overrides.verbose = true;
        break;

    }
  }
  return overrides;
}
