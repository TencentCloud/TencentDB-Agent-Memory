import type { InstanceEntry } from './config/instance-registry.js';
import type { PanelConfig } from './config/panel-config.js';
import { InstanceRegistry } from './config/instance-registry.js';
import { ConsoleLogger } from './infra/console-logger.js';
import { FetchKernelHttpAdapter } from './kernel/adapters/fetch-kernel-http-adapter.js';
import { FetchMetaKernelAdapter } from './kernel/adapters/fetch-meta-kernel-adapter.js';
import { FetchSkillKernelAdapter } from './kernel/adapters/fetch-skill-kernel-adapter.js';
import type { KernelHttpPort } from './kernel/ports/kernel-http-port.js';
import type { MetaKernelPort } from './kernel/ports/meta-kernel-port.js';
import type { SkillKernelPort } from './kernel/ports/skill-kernel-port.js';
import type { Logger } from './infra/logger.js';
import type { KnowledgeClientPort } from './kernel/ports/knowledge-client-port.js';
import { HttpKnowledgeClient } from './kernel/adapters/http-knowledge-client.js';
import { KnowledgeTaskRegistry } from './state/knowledge-task-registry.js';
import { IngestProgressStore } from './state/ingest-progress-store.js';

export interface PanelDeps {
  config: PanelConfig;
  logger: Logger;
  instanceRegistry: InstanceRegistry;
  kernelHttp: KernelHttpPort;
  metaKernel: MetaKernelPort;
  /** 按请求 instanceId 构造 KS 客户端（x-tdai-service-id = instanceId）。 */
  knowledgeClientFactory: (instanceId: string) => KnowledgeClientPort;
  skillKernel: SkillKernelPort;
  /** Knowledge 抽取任务内存态：create 时 stash owner key，callback ready 时取出注册 meta asset。 */
  knowledgeTaskRegistry: KnowledgeTaskRegistry;
  /** Wiki ingest 细粒度进度（KS ingest_progress 回调写入；wiki/get 聚合读出）。 */
  ingestProgressStore: IngestProgressStore;
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
  const knowledgeTaskRegistry = new KnowledgeTaskRegistry();
  const ingestProgressStore = new IngestProgressStore();
  return {
    config,
    logger,
    instanceRegistry,
    kernelHttp,
    metaKernel,
    knowledgeClientFactory,
    skillKernel,
    knowledgeTaskRegistry,
    ingestProgressStore,
  };
}

export type { InstanceEntry };
