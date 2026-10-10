/**
 * Task 外部来源模块统一出口。
 *
 * 对外只暴露：类型、注册中心、导入服务、TAPD provider。
 * 所有内部服务地址来自部署配置，本模块不内置任何域名。
 *
 * 注：导入是**一次性快照**，不提供「同步远端变更」能力（无定时同步、
 * 无抽屉页手动同步），故本模块没有 sync 出口。
 */

export * from "./types.js";
export { TaskSourceRegistry, type TaskSourceMeta } from "./registry.js";
export {
  TaskSourceImportService,
  readExternalRef,
  IMPORT_AGENT_ID,
  type ExternalRef,
  type ImportItem,
  type ImportResult,
} from "./import-service.js";
export { tapdProvider } from "./providers/tapd/index.js";
