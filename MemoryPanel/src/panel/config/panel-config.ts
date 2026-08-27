import { config as loadDotenv } from 'dotenv';
import type { LogLevel } from '../infra/logger.js';

loadDotenv();

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export interface PanelConfig {
  server: { host: string; port: number };
  metadataInstancesConfig: string;
  metadataRemoteTimeoutMs: number;
  ui: { distDir: string };
  log: { level: LogLevel; format: 'json' | 'pretty' };
  /** Knowledge Service (KS :8421) 连接配置。serviceId 按请求 instanceId 注入。 */
  knowledge: { baseUrl: string; authToken: string; timeoutMs: number };
  /**
   * 启动时为每个实例确保 knowledge-service LLM 绑定（走 proxy 记账）。
   * sync=false 时完全跳过（不改变现有部署行为）。
   */
  knowledgeLlmBinding: {
    sync: boolean;
    proxyBaseUrl: string;
  };
  /** 默认 Agent 模板文件的本地存储目录根（存 Panel 本地，按 {dir}/{instanceId}/{team_id}/template.json）。 */
  agentTemplateDir: string;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export function loadPanelConfig(): PanelConfig {
  const level = env('LOG_LEVEL', 'info') as LogLevel;
  const format = env('LOG_FORMAT', 'json') as 'json' | 'pretty';
  return {
    server: {
      host: env('HOST', '0.0.0.0'),
      port: envInt('PORT', 8123),
    },
    metadataInstancesConfig: env('METADATA_INSTANCES_CONFIG', './config/metadata-instances.json'),
    metadataRemoteTimeoutMs: envInt('METADATA_REMOTE_TIMEOUT_MS', 15_000),
    ui: { distDir: env('UI_DIST_DIR', './web/dist') },
    log: {
      level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
      format: format === 'pretty' ? 'pretty' : 'json',
    },
    knowledge: {
      baseUrl: env('KNOWLEDGE_SERVICE_URL', 'http://127.0.0.1:8421'),
      authToken: env('KNOWLEDGE_AUTH_TOKEN', ''),
      timeoutMs: envInt('KNOWLEDGE_TIMEOUT_MS', 15_000),
    },
    knowledgeLlmBinding: {
      sync: envBool('KNOWLEDGE_LLM_BINDING_SYNC', true),
      proxyBaseUrl: env('KNOWLEDGE_LLM_PROXY_BASE_URL', 'http://127.0.0.1:8096'),
    },
    agentTemplateDir: env('TDAI_AGENT_TEMPLATE_DIR', './data/agent-templates'),
  };
}
