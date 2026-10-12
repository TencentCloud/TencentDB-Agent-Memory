/**
 * Task 外部来源**导入**的业务编排。
 *
 *   - 导入：逐条拉详情 → createTask（source_type + source_url 落库）→ 分流 created/failed
 *     → 「参与的 User」只同步 TAPD 处理人（不含导入人；查不到账号则跳过）
 *
 * 导入是**一次性快照**：不提供「同步远端变更」（无定时同步、无抽屉页手动同步）。
 * 远端后续变更不回流 —— 这也正是无需存储凭证的原因。
 * 只把既有的 source_type / source_url 用起来，不新增列、不建表。
 */

import type { MetadataService } from "../metadata/service/metadata-service.js";
import type { V3AuthContext } from "../metadata/router/auth.js";
import type { TaskEntity } from "../metadata/types.js";
import { TaskSourceError, type SourceCredential } from "./types.js";
import { TaskSourceRegistry } from "./registry.js";

/** 落在 metadata_json.external 的定位三元组。 */
export interface ExternalRef {
  provider: string;
  item_type: string;
  external_id: string;
  scope: string;
}

export interface ImportItem {
  external_id: string;
  item_type: string;
  scope: string;
}

export interface ImportResult {
  created: Array<{ external_id: string; task_id: string }>;
  failed: Array<{ external_id: string; error: string }>;
}

/**
 * 导入产生的参与记录使用的 agent_id 哨兵值。
 *
 * participation_log 的 agent_id 必填（appendParticipationLog 内部
 * assertParticipationContext → getAgentById 不存在会抛 agent_not_found），
 * 而导入场景没有真实 agent，只能用固定哨兵值。
 *
 * **不含具体来源名**：所有来源共用这一个。若按来源拆成 `tapd-import` /
 * `jira-import`，每接一个源就要加一条假 agent 记录并同步前端过滤名单 ——
 * 来源标识应读参与记录的 metadata（记了 provider），不该编码进 agent_id。
 *
 * ⚠️ 该哨兵必须在 meta_agents 里**真实存在**，否则每条参与记录都会被拒。
 * 现由 ensureImportAgent() 在导入时幂等补足。
 */
export const IMPORT_AGENT_ID = "external-import";

/**
 * 账号名查找时尝试的 auth_provider 顺序。
 *
 * 实测同一 TAPD 账号可能落在不同认证域（如 local / api_key），
 * 单查一个域会漏。顺序按「最常见的外部映射域 → 本地域」排列。
 */
const USERNAME_LOOKUP_PROVIDERS = ["api_key", "local", "woa"] as const;

export class TaskSourceImportService {
  constructor(private readonly svc: MetadataService) {}

  /**
   * 确保哨兵 agent 在 meta_agents 里存在（幂等）。
   *
   * appendParticipationLog 会校验 agent_id 对应记录存在，缺失则抛
   * `agent_not_found` —— 而导入场景没有真实 agent，只能自建一条哨兵记录。
   * 这里直接走 store.createAgent（绕过 createAgentForCaller 的「成员权限 +
   * owner 本人」校验）：哨兵是系统级记账实体，不属于任何人的资产。
   *
   * 失败不阻断导入，但**不能静默**：静默 catch 曾让「参与的 User 全空」
   * 被掩盖数轮，必须留 warn 线索。
   */
  async ensureImportAgent(teamId: string, ownerUserId: string): Promise<void> {
    try {
      // meta_agents.owner_user_id 是 NOT NULL；导入路径已确保 ctx.userId 有值
      // （createTaskForCaller 用它作 creator），取不到时宁可不建也不要写脏数据。
      if (!ownerUserId) {
        console.warn("[task-source] ensureImportAgent skipped: missing owner user id");
        return;
      }
      const existing = await this.svc.rawStore.getAgentById(IMPORT_AGENT_ID);
      if (existing) return;
      await this.svc.rawStore.createAgent({
        agent_id: IMPORT_AGENT_ID,
        team_id: teamId,
        owner_user_id: ownerUserId,
        name: "外部任务导入",
        description: "第三方需求系统（TAPD）批量导入产生的参与记录归属方",
        visibility: "team",
        status: "active",
      });
    } catch (err) {
      console.warn(
        `[task-source] ensureImportAgent failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 账号名 → user_id。
   *
   * auth_provider 未知（实测同一账号可能落在 local / api_key 等不同域），
   * 因此按候选 provider 依次尝试，命中即返回；查不到返回 null ——
   * **不自动建档**：TAPD 处理人可能是团队外账号（实测 aleronwang 就不在
   * 用户表内），自动创建会凭空产生未经身份验证的账号。
   */
  private async lookupUserIdByUsername(username: string): Promise<string | null> {
    const store = this.svc.rawStore;
    for (const provider of USERNAME_LOOKUP_PROVIDERS) {
      try {
        const user = await store.getUserByUsername(provider, username);
        if (user?.user_id) return user.user_id;
      } catch {
        // 逐个 provider 尝试，失败继续。
      }
    }
    return null;
  }

  /**
   * 批量导入。
   *
   * 单条失败不阻断其余（逐条 try/catch 分流）—— 这是「批量」的核心承诺：
   * 不能因为第 N 条挂了就让前面已成功的回滚或整体失败。
   */
  async import(
    providerId: string,
    teamId: string,
    items: ImportItem[],
    cred: SourceCredential,
    ctx: V3AuthContext,
  ): Promise<ImportResult> {
    await this.svc.assertExternalTaskImportAllowed(teamId, ctx);

    const provider = TaskSourceRegistry.get(providerId);
    if (items.length > provider.maxBatchSize) {
      throw new TaskSourceError(
        "batch_too_large",
        `batch size ${items.length} exceeds limit ${provider.maxBatchSize}`,
      );
    }
    const tctx = TaskSourceRegistry.contextFor(providerId, cred);
    // 参与记录挂在哨兵 agent 下，而 appendParticipationLog 会校验该 agent 存在 ——
    // 必须在写入前确保它已建好，否则每条都会被 agent_not_found 拒掉。
    await this.ensureImportAgent(teamId, ctx.userId ?? "");

    const result: ImportResult = { created: [], failed: [] };
    for (const item of items) {
      try {
        const detail = await provider.fetchTask(tctx, item.external_id, item.scope, item.item_type);
        const task = await this.svc.createTaskForCaller(
          {
            team_id: teamId,
            creator_user_id: ctx.userId,
            title: detail.title || "(无标题)",
            description: detail.body || null,
            /**
             * source_type 只表达**大类**，不编码具体来源 ——
             * 具体来源一律读 metadata_json.external.provider（见下方 metadata_json）。
             *
             * 若把每个来源塞进 TaskSourceType 枚举，新增来源就要改类型定义 +
             * 所有引用它的地方（types / schemas / gateway 生成物 / 前端），
             * 抽象会被钉死在「已知来源列表」上；用大类则新增来源零改动。
             */
            source_type: "external",
            source_url: detail.url ?? null,
            metadata_json: JSON.stringify({
              external: {
                provider: providerId,
                item_type: item.item_type,
                external_id: item.external_id,
                scope: item.scope,
              } satisfies ExternalRef,
            }),
          },
          ctx,
        );
        // 「参与的 User」只同步 TAPD 处理人（**不含导入人**）：
        // 处理人是条目的实际负责人，导入人只是搬运者，不该被记成参与者。
        // 账号名查不到对应 user_id 则跳过（不自动建档、不阻断导入）。
        if (detail.owner) {
          const ownerId = await this.lookupUserIdByUsername(detail.owner);
          if (ownerId) {
            try {
              await this.svc.appendParticipationLog({
                team_id: teamId,
                task_id: task.task_id,
                agent_id: IMPORT_AGENT_ID,
                user_id: ownerId,
                source: "task-import",
                metadata_json: JSON.stringify({ provider: providerId }),
              });
            } catch (err) {
              // 参与记录失败不影响导入本身，但**不能静默**（历史教训）。
              console.warn(
                `[task-source] appendParticipationLog failed (task=${task.task_id}, user=${ownerId}): ` +
                  `${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
        result.created.push({ external_id: item.external_id, task_id: task.task_id });
      } catch (err) {
        // 不去重：库上无 source_url 唯一索引，同一条目可重复导入。
        // 因此也没有「已导入 → skipped」这一分支，失败一律进 failed。
        result.failed.push({ external_id: item.external_id, error: messageOf(err) });
      }
    }
    return result;
  }

}

/** 从 metadata_json.external 读取定位三元组；缺失或不合法返回 null。 */
export function readExternalRef(task: TaskEntity): ExternalRef | null {
  if (!task.metadata_json) return null;
  try {
    const parsed = JSON.parse(task.metadata_json) as { external?: Partial<ExternalRef> };
    const e = parsed?.external;
    if (!e?.provider || !e?.external_id || !e?.item_type) return null;
    return {
      provider: e.provider,
      item_type: e.item_type,
      external_id: e.external_id,
      scope: e.scope ?? "",
    };
  } catch {
    return null;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
