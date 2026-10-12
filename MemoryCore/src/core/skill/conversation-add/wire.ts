/**
 * wire.ts — skill conversation-add 的 handler wiring 入口。
 *
 * 2026-07-30 池化重构后:
 *   - 老 wireConversationAdd (per-instance handler + per-instance worker) 已删除。
 *   - gateway 每 instance 调 wireConversationAddHandler 只造 handler/trigger/sink/buffer,
 *     worker 由全进程唯一的 SkillWorkerPool 管理。
 */

import type { StorageAdapter } from "../../storage/adapter.js";
import type { ISkillExtractor, ExtractorLogger } from "../queue/types.js";

import { SkillBufferStorage } from "./buffer-storage.js";
import {
  LocalSkillAgentTaskQueue,
  RedisSkillAgentTaskQueue,
  type ISkillAgentTaskQueue,
  type RedisLike as AgentQueueRedisLike,
} from "./agent-task-queue.js";
import { SkillTriggerService } from "./trigger-service.js";
import { SkillConversationAddHandler, type HandlerThresholds } from "./add-handler.js";
import type { CompressOptions } from "./message-compressor.js";
import type { OversizeOptions } from "./oversize-strategy.js";
import type { SkillCandidatesSink } from "./extract-worker.js";
import { SkillCoreSink, type MetadataServiceLike } from "./skill-core-sink.js";

export interface WireConversationAddDeps {
  storage: StorageAdapter;
  /** 生产：ioredis client；测试：LocalSkillAgentTaskQueue 直接注入到 `queue` 覆盖 */
  redis?: AgentQueueRedisLike;
  /** 测试注入的 queue；不传就基于 redis 构造 RedisSkillAgentTaskQueue */
  queue?: ISkillAgentTaskQueue;
  /** Redis key 前缀，默认 "skill" —— 与设计文档 §5 对齐 */
  redisKeyPrefix?: string;

  /**
   * sink 兜底登记 skill asset 需要的 metadata service（幂等）。
   * 不传时 sink 是 no-op —— skill 已由 extractor 的 tool-call 落库，
   * 只是前端管控页可能看不到（standalone 模式下无 onSkillCreated 钩子）。
   */
  metadataService?: MetadataServiceLike;

  /**
   * 保留字段用于跟老签名兼容 (wireConversationAddHandler 内部不使用 extractor,
   * 真正的抽取由 SkillWorkerPool 的 resolveExtractor 现取)。gateway 侧当前
   * 塞了一个 noop 占位。
   */
  extractor: ISkillExtractor;

  logger: ExtractorLogger;

  /** Handler 阈值覆盖 */
  thresholds?: Partial<HandlerThresholds>;

  /** 单条 tool 消息头尾压缩规则覆盖 (对应 SkillConfig.compress)。 */
  compressOptions?: Partial<CompressOptions>;

  /** 兜底切分参数覆盖 (对应 SkillConfig.extraction 派生的 chunkMaxBytes / headKeepBytes / tailKeepBytes)。 */
  oversizeOptions?: Partial<OversizeOptions>;

  /** COS 子路径（默认 "skill_buffer"） */
  bufferSubPath?: string;
}

/**
 * 只造 handler 需要的 4 件套 (handler / trigger / sink / buffer) +
 * queue (如果没注入则按 redis/内存分派)。**不启 worker**。
 *
 * 全进程 worker 由 SkillWorkerPool 统一管理; gateway 每 instance 首次访问
 * 时调本函数拿到 handler bundle 塞入 in-flight cache, 后续复用。
 */
export interface WiredConversationAddHandler {
  handler: SkillConversationAddHandler;
  trigger: SkillTriggerService;
  sink: SkillCandidatesSink;
  queue: ISkillAgentTaskQueue;
  buffer: SkillBufferStorage;
}

export function wireConversationAddHandler(
  deps: WireConversationAddDeps,
): WiredConversationAddHandler {
  const buffer = new SkillBufferStorage({
    storage: deps.storage,
    subPath: deps.bufferSubPath,
  });

  let queue: ISkillAgentTaskQueue;
  if (deps.queue) {
    queue = deps.queue;
  } else if (deps.redis) {
    queue = new RedisSkillAgentTaskQueue({
      client: deps.redis,
      keyPrefix: deps.redisKeyPrefix ?? "skill",
    });
  } else {
    // 无 Redis 的降级：仅 standalone 单机场景可用
    queue = new LocalSkillAgentTaskQueue();
    deps.logger.warn(
      "[skill-conversation-add] no redis nor queue injected — falling back to in-memory queue (single-node only)",
    );
  }

  const trigger = new SkillTriggerService({ buffer, queue });
  const handler = new SkillConversationAddHandler({
    buffer,
    trigger,
    thresholds: deps.thresholds,
    compressOptions: deps.compressOptions,
    oversizeOptions: deps.oversizeOptions,
  });

  const sink = new SkillCoreSink({
    metadata: deps.metadataService,
    logger: deps.logger,
  });

  return { handler, trigger, sink, queue, buffer };
}
