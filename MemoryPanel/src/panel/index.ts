import { serve } from '@hono/node-server';
import { loadPanelConfig } from './config/panel-config.js';
import { buildPanelApp } from './http/app.js';
import { buildPanelDeps } from './panel-deps.js';
import { ensureKnowledgeLlmBindings } from './startup/ensure-knowledge-llm-binding.js';

export function main(): void {
  const config = loadPanelConfig();
  const deps = buildPanelDeps(config);
  const app = buildPanelApp(deps);

  serve(
    { fetch: app.fetch, hostname: config.server.host, port: config.server.port },
    (info) => {
      deps.logger.info('panel listening', {
        url: `http://${config.server.host}:${info.port}`,
        mode: 'stateless',
        metadataApi: '/api/v1/meta/*',
        instancesConfig: config.metadataInstancesConfig,
      });
    },
  );

  // Best-effort: ensure per-instance knowledge-service LLM bindings (design 009 §4.2).
  // Non-blocking; failures are logged and left for manual recovery.
  if (config.knowledgeLlmBinding.sync) {
    void ensureKnowledgeLlmBindings(
      deps.instanceRegistry.listAll(),
      {
        knowledgeBaseUrl: config.knowledge.baseUrl,
        knowledgeAuthToken: config.knowledge.authToken,
        proxyBaseUrl: config.knowledgeLlmBinding.proxyBaseUrl,
        timeoutMs: config.knowledge.timeoutMs,
      },
      deps.logger,
    );
  }

  // API 调用审计初始化（建表 + schema 自愈 + 启动定时刷盘）。非阻塞，失败只 warn。
  // 建完表后异步跑 user_id 回填，用 telemetry_meta 表版本号防重跑。
  void (async () => {
    await deps.apiCallTelemetry.initialize();
    await deps.apiCallTelemetry.runBackfillIfNeeded(deps.userIdResolver);
  })();

  const shutdown = async (): Promise<void> => {
    deps.logger.info('panel shutting down');
    await deps.apiCallTelemetry.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
