import type { InstanceEntry } from './config/instance-registry.js';
import type { PanelConfig } from './config/panel-config.js';
import { InstanceRegistry } from './config/instance-registry.js';
import { ConsoleLogger } from './infra/console-logger.js';
import { FetchKernelHttpAdapter } from './kernel/adapters/fetch-kernel-http-adapter.js';
import { FetchMetaKernelAdapter } from './kernel/adapters/fetch-meta-kernel-adapter.js';
import { FetchSkillKernelAdapter } from './kernel/adapters/fetch-skill-kernel-adapter.js';
import { FetchAnalyticsKernelAdapter } from './kernel/adapters/fetch-analytics-kernel-adapter.js';
import type { KernelHttpPort } from './kernel/ports/kernel-http-port.js';
import type { MetaKernelPort } from './kernel/ports/meta-kernel-port.js';
import type { SkillKernelPort } from './kernel/ports/skill-kernel-port.js';
import type { AnalyticsKernelPort } from './kernel/ports/analytics-kernel-port.js';
import type { Logger } from './infra/logger.js';
import type { KnowledgeClientPort } from './kernel/ports/knowledge-client-port.js';
import { HttpKnowledgeClient } from './kernel/adapters/http-knowledge-client.js';
import { KnowledgeTaskRegistry } from './state/knowledge-task-registry.js';
import { IngestProgressStore } from './state/ingest-progress-store.js';
import { createPanelApiCallTelemetry, type PanelApiCallTelemetry } from './infra/api-call-telemetry.js';
import { PanelAuthService } from './auth/service.js';
import { PanelUserIdResolver } from './infra/user-id-resolver.js';

export interface PanelDeps {
  config: PanelConfig;
  logger: Logger;
  instanceRegistry: InstanceRegistry;
  kernelHttp: KernelHttpPort;
  metaKernel: MetaKernelPort;
  /** 按请求 instanceId 构造 KS 客户端（x-tdai-service-id = instanceId）。 */
  knowledgeClientFactory: (instanceId: string) => KnowledgeClientPort;
  skillKernel: SkillKernelPort;
  /** 内核 /v3/analytics/* 查询面透明代理（GET/POST 按 action 分流）。 */
  analyticsKernel: AnalyticsKernelPort;
  /** Knowledge 抽取任务内存态：create 时 stash owner key，callback ready 时取出注册 meta asset。 */
  knowledgeTaskRegistry: KnowledgeTaskRegistry;
  /** Wiki ingest 细粒度进度（KS ingest_progress 回调写入；wiki/get 聚合读出）。 */
  ingestProgressStore: IngestProgressStore;
  /** 可选 ClickHouse API 调用审计。未配则 NoOp，零开销。 */
  apiCallTelemetry: PanelApiCallTelemetry;
  /** 兼容 user_key 与可选 IdP 登录的统一认证服务。 */
  auth: PanelAuthService;
  /** user_key → user_id 缓存解析器（telemetry 埋点用；auth/verify 后台刷新）。 */
  userIdResolver: PanelUserIdResolver;
}

export function buildPanelDeps(config: PanelConfig): PanelDeps {
  const logger = new ConsoleLogger({
    level: config.log.level,
    format: config.log.format,
  });
  const instanceRegistry = InstanceRegistry.load(config.metadataInstancesConfig);
  const kernelHttp = new FetchKernelHttpAdapter(logger);
  const metaKernel = new FetchMetaKernelAdapter(kernelHttp, config.metadataRemoteTimeoutMs);
  const knowledgeClientFactory = (instanceId: string): KnowledgeClientPort =>
    new HttpKnowledgeClient({
      baseUrl: config.knowledge.baseUrl,
      authToken: config.knowledge.authToken,
      serviceId: instanceId,
      timeoutMs: config.knowledge.timeoutMs,
    });
  const skillKernel = new FetchSkillKernelAdapter(kernelHttp, config.metadataRemoteTimeoutMs);
  const analyticsKernel = new FetchAnalyticsKernelAdapter(kernelHttp, config.metadataRemoteTimeoutMs);
  const knowledgeTaskRegistry = new KnowledgeTaskRegistry();
  const ingestProgressStore = new IngestProgressStore();
  // instance_id → gateway 参数：telemetry backfill 需要 per-instance 调 auth/verify
  const instanceCtxProvider = (instanceId: string) => {
    try {
      const entry = instanceRegistry.resolve(instanceId);
      return {
        instanceId: entry.instance_id,
        gatewayEndpoint: entry.gateway_endpoint,
        gatewayApiKey: entry.api_key,
      };
    } catch {
      // instance 已从 registry 移除（老 CH 数据引用了下线的 instance）→ 跳过
      return null;
    }
  };
  const apiCallTelemetry = createPanelApiCallTelemetry(
    config.clickhouse,
    logger,
    instanceCtxProvider,
  );
  const userIdResolver = new PanelUserIdResolver(metaKernel, logger);
  const auth = new PanelAuthService({ config: config.auth, instances: instanceRegistry, metaKernel, logger });
  return {
    config,
    logger,
    instanceRegistry,
    kernelHttp,
    metaKernel,
    knowledgeClientFactory,
    skillKernel,
    analyticsKernel,
    knowledgeTaskRegistry,
    ingestProgressStore,
    apiCallTelemetry,
    auth,
    userIdResolver,
  };
}

export type { InstanceEntry };
