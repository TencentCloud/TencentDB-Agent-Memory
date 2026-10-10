/**
 * TAPD 外部任务来源 provider。
 *
 * 支持需求（story）/ 任务（task）/ 缺陷（bug）三类，均可按工作空间（项目）批量导入。
 * 认证用用户手工填入的长期令牌：太湖统一认证令牌（bearer）或 TAPD 个人令牌（custom），
 * 由调用方经 TaskSourceContext 注入。
 *
 * 所有端点与站点根来自部署配置（经 registry.contextFor 注入），本文件不内置任何域名。
 */

import { TaskSourceError, type CandidatePage, type ListCandidatesQuery, type RemoteTaskDetail, type RemoteTaskRef, type TaskSourceContext, type TaskSourceProvider, type TaskWorkspace } from "../../types.js";
import { TapdMcpClient, totalOf, unwrap } from "./mcp-client.js";
import {
  ITEM_TYPES,
  isItemType,
  keywordField,
  ownerField,
  rowScope,
  supportsVStatus,
  toDetail,
  toRef,
  toolFor,
} from "./mapper.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_BATCH_SIZE = 50;

function clientFor(ctx: TaskSourceContext): TapdMcpClient {
  // custom 认证（TAPD 个人令牌）走专用 header；bearer（太湖令牌）走 Authorization。
  const headerName =
    ctx.cred.kind === "custom" && typeof ctx.cred.extra?.header === "string"
      ? ctx.cred.extra.header
      : undefined;
  return new TapdMcpClient({
    endpoint: ctx.endpoint,
    token: ctx.cred.secret,
    tokenHeader: headerName,
    timeoutMs: ctx.timeoutMs,
  });
}

function asRows(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object");
}

/**
 * 脱敏诊断：workspaces 为空是「令牌无效/不完整/账号无项目」的典型表现，
 * 但接口本身返回 200，容易被误判成「面板没加载」。
 *
 * **只记种类与长度**，绝不写令牌明文 —— 连前缀也不记：结构化前缀（如令牌族标识）
 * 本身就能定位令牌类型/环境，等同于泄漏形态。
 * 端点属内网基础设施地址，同样只记「是否已配置」而不回显值。
 */
function diagnosticLog(ctx: TaskSourceContext, raw: unknown): void {
  const rows = Array.isArray(raw) ? raw : [];
  if (rows.length > 0) return;
  console.warn(
    "[task-source:tapd] listWorkspaces 返回空 — " +
      `kind=${ctx.cred.kind} token.len=${ctx.cred.secret.length} ` +
      `endpointSet=${Boolean(ctx.endpoint)} ` +
      `rawType=${Array.isArray(raw) ? "array(0)" : typeof raw}`,
  );
}

export const tapdProvider: TaskSourceProvider = {
  id: "tapd",
  itemTypes: ITEM_TYPES,
  maxBatchSize: MAX_BATCH_SIZE,
  needsWorkspace: true,
  /**
   * TAPD 走 MCP 且 task 类不返回详情链接，故两个都要：
   *   - MCP_URL：MCP 端点
   *   - SITE_BASE_URL：构造详情页 URL 的站点根
   * 声明在这里而非 registry，接新来源时无需改动通用层。
   */
  requiredEnv: ["MCP_URL", "SITE_BASE_URL"],
  // 待办接口（user_todo_*_get）是 TAPD 特有能力，声明后前端才显示「待办」开关。
  capabilities: { todo: true },
  // 两种令牌打到同一端点，仅 header 名不同（实测确认）。
  // 输入框下方**只显示**「如何获取令牌？」链接（tokenUrlEnv 下发），
  // 不再附带任何说明文案 —— 文案曾诱导用户把示例当内容填（直接填了示例字面量）。
  authSchemes: [
    {
      kind: "bearer",
      label: "太湖统一认证令牌",
      // 申请页在太湖（与 TAPD 不同域），且 iWiki 也用同一个太湖 PAT 页 ——
      // 故指向**全局共用**的 TAI_PAT_URL（完整 URL），改地址只改一处。
      tokenUrlEnv: "TAI_PAT_URL",
    },
    {
      kind: "custom",
      headerName: "x-tapd-access-token",
      label: "TAPD 个人令牌",
      tokenUrlEnv: "TASK_SOURCE_TAPD_PERSONAL_TOKEN_URL",
    },
  ],

  async listWorkspaces(ctx: TaskSourceContext): Promise<TaskWorkspace[]> {
    const client = clientFor(ctx);
    const raw = await client.call("user_participant_workspace_get", {});
    // 脱敏诊断：只记种类/长度/前缀，绝不记令牌明文。
    // 项目列表来自「我参与的项目」，与令牌所属账号强相关 —— 为空时需先确认令牌是否
    // 完整且属于有项目权限的账号。
    diagnosticLog(ctx, raw);
    return asRows(raw)
      .filter((r) => (r["status"] === undefined || r["status"] === "normal"))
      .map((r) => ({
        id: String(r["id"] ?? ""),
        name: typeof r["name"] === "string" ? r["name"] : String(r["id"] ?? ""),
      }))
      .filter((w) => w.id);
  },

  async listCandidates(ctx: TaskSourceContext, q: ListCandidatesQuery): Promise<CandidatePage> {
    // workspace_id 是常规列表接口的强制入参（stories_get / tasks_get / bugs_get 都要求），
    // 但**待办接口是可选的**：不传 = 跨项目的全部待办，传了 = 只看该项目。
    // 因此强制校验只在非待办模式下生效。
    if (!q.onlyTodo && !q.scope) {
      throw new TaskSourceError("missing_scope", "TAPD requires workspace_id");
    }
    const types = (q.itemTypes?.length ? q.itemTypes : ITEM_TYPES.map((t) => t.id)).filter(
      (t): t is string => typeof t === "string" && isItemType(t),
    );
    if (!types.length) {
      throw new TaskSourceError("invalid_item_type", "no supported item types requested");
    }

    const limit = clampLimit(q.limit);
    const page = Number.isFinite(q.page) && (q.page ?? 0) > 0 ? Math.floor(q.page as number) : 1;
    const client = clientFor(ctx);

    // 待办模式：接口**只接受 workspace_id**（其余参数传入即被拒），且不支持服务端分页 ——
    // 全量拉回后本地切片。关键字/处理人/状态条件在待办模式下无效（服务端会拒参）。
    if (q.onlyTodo) {
      // scope 为空 → 不传 workspace_id，取当前用户跨项目的全部待办；
      // 非空 → 只看该项目。每行自带 workspace_id，用它取代请求级 scope 定位。
      const todoArgs = q.scope ? { workspace_id: q.scope } : {};
      const perType = await Promise.all(
        types.map(async (itemType) => {
          const raw = await client.callRaw(toolFor(itemType, true), todoArgs);
          const rows = asRows(unwrapData(raw));
          return { itemType, rows };
        }),
      );
      // 状态中文：**只有指定项目时**待办接口才返回中文（实测跨项目返回 new/status_6
      // 这类原始码）。跨项目时按行内 workspace_id 分组补查映射表，让展示保持一致。
      const statusMaps = q.scope
        ? {}
        : await loadTodoStatusMaps(client, rowsByScope(perType));

      const items: RemoteTaskRef[] = perType
        .flatMap(({ itemType, rows }) =>
          rows.map((r) => {
            // 跨项目模式下 scope 只能从行内取：行内是 number，需显式转换，
            // 否则详情页 URL 会拼出 `tapd_fe//story/...` 这种空段路径。
            const scope = rowScope(r, q.scope ?? "");
            return toRef(r, itemType, ctx.siteBaseUrl, scope, undefined, statusMaps[`${scope}:${itemType}`]);
          }),
        )
        .filter((r) => r.externalId);
      const total = items.length;
      const start = (page - 1) * limit;
      return { items: items.slice(start, start + limit), total, hasMore: start + limit < total };
    }

    // 各类型并发拉取后合并：TAPD 没有跨类型统一列表接口。
    const perType = await Promise.all(
      types.map(async (itemType) => {
        const args: Record<string, unknown> = { workspace_id: q.scope, limit, page };
        if (q.keyword) args[keywordField(itemType)] = q.keyword;
        // 处理人字段名按类型区分：bug 是 current_owner，story/task 是 owner。
        // 用错会触发服务端「参数X不存在于工具Y的参数定义中」错误文本。
        if (q.owner) args[ownerField(itemType)] = q.owner;
        if (q.status) args["status"] = q.status;
        // 中文状态：仅 story 支持，其余类型下发会被服务端拒绝（见 mapper.supportsVStatus）。
        if (supportsVStatus(itemType)) args["with_v_status"] = "1";
        // 一次调用同时拿到分页包络（total）与数据行（data）。
        const raw = await client.callRaw(toolFor(itemType), args);
        const rows = asRows(unwrapData(raw));
        return { itemType, rows, total: totalOf(raw, rows.length) };
      }),
    );

    // task / bug 不支持 with_v_status，需要另取状态中文映射表。
    const statusMaps = await loadStatusLabelMaps(client, types, q.scope as string);

    const items: RemoteTaskRef[] = perType
      .flatMap(({ itemType, rows }) =>
        rows.map((r) =>
          toRef(r, itemType, ctx.siteBaseUrl, q.scope as string, undefined, statusMaps[itemType]),
        ),
      )
      .filter((r) => r.externalId);

    // 排序沿用 TAPD 返回顺序（服务端默认 created desc，实测三类一致）。
    //
    // 注意：此处**不**再本地按 updatedAt 重排。分页发生在服务端且基准是 created，
    // 若本地按 modified 重排会导致「第 2 页出现比第 1 页更新的条目」这类翻页错乱。
    // 各类型并发拉取时，每类各返回 limit 条，合并后最多 limit × 类型数 ——
    // 若直接返回会让前端一页显示远超 PAGE_SIZE 的行（表现为「一页显示了所有」），
    // 故合并后统一截断到 limit，保持与单页大小一致。
    const paged = items.slice(0, limit);
    const total = perType.reduce((sum, t) => sum + t.total, 0);
    return { items: paged, total, hasMore: page * limit < total };
  },

  async fetchTask(
    ctx: TaskSourceContext,
    externalId: string,
    scope: string,
    itemType: string,
  ): Promise<RemoteTaskDetail> {
    if (!isItemType(itemType)) {
      throw new TaskSourceError("invalid_item_type", `unsupported TAPD item type: ${itemType}`);
    }
    const client = clientFor(ctx);
    // 详情接口才返回 description（列表模式该字段为 null / 缺失）。
    const raw = await client.call(toolFor(itemType), {
      workspace_id: scope,
      id: externalId,
    });
    const rows = asRows(raw);
    if (!rows.length) {
      throw new TaskSourceError("remote_task_not_found", `TAPD ${itemType} not found: ${externalId}`);
    }
    return toDetail(rows[0], itemType, ctx.siteBaseUrl, scope);
  },
};

function unwrapData(raw: unknown): unknown {
  return unwrap(raw);
}

function clampLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(limit as number), 1), MAX_LIMIT);
}

/**
 * 取各类型的状态中文映射表（仅对不支持 with_v_status 的类型才需要）。
 *
 * `tapd_field_detail_get(object_type, field_names="status")` 返回
 * `{ status: { options: { "new": "新", "in_progress": "接受/处理", ... } } }`。
 * 失败时静默回落到英文码 —— 状态展示降级不应阻断列表查询。
 */
async function loadStatusLabelMaps(
  client: TapdMcpClient,
  types: readonly string[],
  scope: string,
): Promise<Record<string, Record<string, string>>> {
  const needed = types.filter((t) => !supportsVStatus(t));
  if (!needed.length) return {};
  const entries = await Promise.all(
    needed.map(async (itemType) => {
      try {
        const raw = await client.call("tapd_field_detail_get", {
          workspace_id: scope,
          object_type: itemType,
          field_names: "status",
        });
        const opts = (raw as { status?: { options?: Record<string, string> } })?.status?.options;
        return [itemType, opts && typeof opts === "object" ? opts : {}] as const;
      } catch {
        // 取不到映射就显示原始状态码，不阻断查询。
        return [itemType, {}] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

/** 待办结果按「行内 workspace_id → 类型」归纳，用于跨项目补查状态映射。 */
function rowsByScope(perType: Array<{ itemType: string; rows: Array<Record<string, unknown>> }>): Array<{
  scope: string;
  itemType: string;
}> {
  const seen = new Set<string>();
  const out: Array<{ scope: string; itemType: string }> = [];
  for (const { itemType, rows } of perType) {
    for (const r of rows) {
      const s = rowScope(r, "");
      if (!s) continue;
      const key = `${s}:${itemType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ scope: s, itemType });
    }
  }
  return out;
}

/**
 * 跨项目待办的状态中文映射（按 project × type 分组查）。
 *
 * 实测：待办接口**指定 workspace_id 时**状态直接是中文，但**跨项目时**返回
 * `new` / `status_6` 这类原始码。为让两种模式展示一致，这里按行内 workspace
 * 补一次 tapd_field_detail_get。
 *
 * 项目数通常很小（实测 2~3 个），查询可控；失败静默回落到原始码，不阻断列表。
 */
async function loadTodoStatusMaps(
  client: TapdMcpClient,
  pairs: Array<{ scope: string; itemType: string }>,
): Promise<Record<string, Record<string, string>>> {
  const entries = await Promise.all(
    pairs.map(async ({ scope, itemType }) => {
      try {
        const raw = await client.call("tapd_field_detail_get", {
          workspace_id: scope,
          object_type: itemType,
          field_names: "status",
        });
        const opts = (raw as { status?: { options?: Record<string, string> } })?.status?.options;
        return [`${scope}:${itemType}`, opts && typeof opts === "object" ? opts : {}] as const;
      } catch {
        return [`${scope}:${itemType}`, {}] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}
