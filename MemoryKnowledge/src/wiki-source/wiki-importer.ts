/**
 * WikiImporter —— 外部 wiki 定时同步的拉取服务（供 AutoSyncScheduler 调用）。
 *
 * 准入（设计 §5.4）：**不设 per-wiki 开关**，wiki 同步跟随全局开关
 * `KNOWLEDGE_AUTO_SYNC_ENABLED`；是否参与由「有无凭据行」决定（§4.2，
 * 凭据行存在 == 外部来源）。调度器侧已按此筛选，这里只负责执行。
 *
 * 同步范围：**每个文档的具体内容全量重拉**。
 * 通用外部源通常没有"按更新时间增量"的可靠接口：
 *   - 列表接口（多数平台仅返回直接子级，需逐层展开）只给标题/层级，
 *     不含正文，也往往不含更新时间
 *   - 正文只能逐篇取
 * 因此每轮同步都重新拉取全部文档正文并覆盖同名文件，
 * 天然覆盖「新增 / 修改 / 删除后重建」三种变化。
 *
 * 与首次导入的差异：首次导入可只勾部分文档（pageIds），
 * 同步**不传 pageIds** → 全量。
 */

import { createLogger } from "../logger.js";
import type { IKnowledgeStore } from "../store/types.js";
import type { WikiServiceLike } from "./import-runner.js";
import { runImport } from "./import-runner.js";
import type { WikiSourceRegistry } from "./registry.js";
import type { WikiImporter } from "../store/auto-sync-scheduler.js";

const log = createLogger("wiki-importer");

export interface WikiImporterDeps {
  registry: WikiSourceRegistry;
  wikiService: WikiServiceLike;
  /** 取 wiki 行，用于拿 source_type（provider id）与 source_url。 */
  store: Pick<IKnowledgeStore, "getWikiById">;
}

export function createWikiImporter(deps: WikiImporterDeps): WikiImporter {
  return {
    async run(serviceId, teamId, wikiId, cred): Promise<number> {
      const row = deps.store.getWikiById(serviceId, wikiId);
      if (!row) {
        log.warn(`[wiki-sync] wiki ${wikiId} not found, skip`);
        return 0;
      }

      const providerId = row.source_type;
      const sourceUrl = row.source_url;
      if (!providerId || !sourceUrl) {
        // 手工上传的 wiki 不该进入候选（调度器按凭据行筛选），这里是防御式检查
        log.debug(`[wiki-sync] wiki ${wikiId} has no external source, skip`);
        return 0;
      }

      if (!deps.registry.get(providerId)) {
        // provider 未在部署中启用（WIKI_SOURCE_ENABLED 未包含该 id）
        log.warn(`[wiki-sync] wiki ${wikiId} provider '${providerId}' not enabled, skip`);
        return 0;
      }

      const result = await runImport({
        registry: deps.registry,
        wikiService: deps.wikiService,
        providerId,
        secret: cred.secret,
        username: cred.username,
        serviceId,
        teamId,
        wikiId,
        sourceUrl,
        // 不传 pageIds → 全量重拉所有文档正文（含新增/修改）
      });

      if (result.failed.length > 0) {
        // 部分失败不抛异常：已成功的文档已落盘，抛了会整轮回滚掉
        log.warn(
          `[wiki-sync] wiki ${wikiId} partially synced: ${result.imported} ok, ${result.failed.length} failed`,
        );
      }
      if (result.warnings.length > 0) {
        log.debug(`[wiki-sync] wiki ${wikiId} warnings: ${result.warnings.join("; ")}`);
      }

      return result.imported;
    },
  };
}
