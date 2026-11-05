/**
 * Task 外部来源注册中心。
 *
 * 对应设计文档 §3.1 / §6。与 Knowledge 侧 WikiSourceRegistry 同构：
 *   - 启用列表来自 TASK_SOURCE_ENABLED（逗号分隔的 provider id）
 *   - 端点等内网地址一律来自部署配置，**无内置默认值**
 *   - 缺失配置 → 构造上下文时显式抛错（fail-fast），不静默降级
 *
 * 代码内不出现任何内网域名，仅在配置注释/示例里体现。
 */

import { tapdProvider } from "./providers/tapd/index.js";
import {
  TaskSourceError,
  type AuthScheme,
  type SourceCredential,
  type TaskSourceContext,
  type TaskSourceItemType,
  type TaskSourceProvider,
} from "./types.js";

/**
 * 认证方式 + 其令牌申请页地址（对外，snake_case）。
 *
 * 与 Knowledge 侧 wiki/code 来源的 `token_doc_url` 同约定：
 * 地址来自部署配置，未配则为 null（前端据此不展示指引链接）。
 */
export interface AuthSchemeMeta extends Omit<AuthScheme, "tokenUrlEnv"> {
  token_doc_url: string | null;
}

/** 对外暴露的来源元数据（不含任何凭据或内部端点）。 */
export interface TaskSourceMeta {
  id: string;
  item_types: readonly TaskSourceItemType[];
  max_batch_size: number;
  needs_workspace: boolean;
  auth_schemes: readonly AuthSchemeMeta[];
  /** 支持的能力，前端据此决定是否显示对应开关（未声明=不支持）。 */
  capabilities: { todo: boolean };
}

const PROVIDERS: Record<string, TaskSourceProvider> = {
  tapd: tapdProvider,
};

/** 读取环境变量（去空白，空串视为未设置）。 */
function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function enabledIds(): string[] {
  return env("TASK_SOURCE_ENABLED")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 认证方式 → 对外形态。
 *
 * `tokenUrlEnv` 是内部字段名，不透出；换成 `token_doc_url` 承载实际地址。
 * 未配置（或配置为空）→ null，前端据此隐藏该方式的「申请/查看」链接。
 */
function toAuthSchemeMeta(scheme: AuthScheme): AuthSchemeMeta {
  const { tokenUrlEnv, ...rest } = scheme as AuthScheme & { tokenUrlEnv?: string };
  // tokenUrlEnv 是**全局** env 名（如 TAI_PAT_URL），不按来源加前缀 ——
  // 同一令牌页可被多个来源共用。
  const url = tokenUrlEnv ? env(tokenUrlEnv) : "";
  return { ...rest, token_doc_url: url || null };
}

/** 已启用的来源列表（供前端渲染「导入 Task」下拉）。未启用任何来源时返回空数组。 */
export function list(): TaskSourceMeta[] {
  return enabledIds()
    .map((id) => PROVIDERS[id])
    .filter((p): p is TaskSourceProvider => Boolean(p))
    .map((p) => ({
      id: p.id,
      item_types: p.itemTypes,
      max_batch_size: p.maxBatchSize,
      needs_workspace: p.needsWorkspace,
      auth_schemes: p.authSchemes.map(toAuthSchemeMeta),
      capabilities: { todo: p.capabilities?.todo === true },
    }));
}

/** 取 provider；未启用或不存在时抛错（不区分存在性，避免探测）。 */
export function get(id: string): TaskSourceProvider {
  const provider = PROVIDERS[id];
  if (!provider || !enabledIds().includes(id)) {
    throw new TaskSourceError("task_source_not_found", `task source not available: ${id}`);
  }
  return provider;
}

/**
 * 组装 provider 调用上下文。
 *
 * **按 provider 自己声明的 requiredEnv 校验**，通用层不预设任何具体配置项 ——
 * 否则「MCP 类来源要 MCP_URL、REST 类来源要 API_URL」的差异会把通用层钉死，
 * 新增来源就得回来改这里。缺失即抛错：硬编码内网地址既是信息暴露，
 * 也会让漏配退化成「跳到错误地址且无报错」的静默错误。
 */
export function contextFor(id: string, cred: SourceCredential): TaskSourceContext {
  const upper = id.toUpperCase();
  const provider = PROVIDERS[id];
  for (const suffix of provider?.requiredEnv ?? []) {
    if (!env(`TASK_SOURCE_${upper}_${suffix}`)) {
      throw new TaskSourceError(
        "task_source_config_missing",
        `TASK_SOURCE_${upper}_${suffix} is not configured`,
      );
    }
  }
  /**
   * 主端点 = requiredEnv 里**第一个**声明的配置项。
   *
   * 通用层不预设它叫什么（MCP_URL 还是 API_URL 由 provider 决定），
   * 只按声明顺序取首个作为「主端点」—— 否则 REST 类来源会因通用层
   * 硬编码读 MCP_URL 而拿到空串，且校验却通过了（静默失败）。
   */
  const primary = provider?.requiredEnv?.[0];
  return {
    cred,
    endpoint: primary ? (env(`TASK_SOURCE_${upper}_${primary}`) ?? "") : "",
    siteBaseUrl: env(`TASK_SOURCE_${upper}_SITE_BASE_URL`) ?? "",
  };
}

export const TaskSourceRegistry = { list, get, contextFor };
