/**
 * TAPD 字段映射：把 story / task / bug 三类的差异收敛在此，上层不出现类型分支。
 *
 * 实测差异（2026-09-15）：
 *   |            | story        | task              | bug               |
 *   | 标题字段    | name         | name              | **title**（无 name）|
 *   | detail_link| ✅ 列表自带   | ❌ 详情也没有      | ✅ 列表自带         |
 *   | description| 仅详情       | 仅详情            | 仅详情             |
 *   | 搜索参数    | name         | name              | **title**          |
 */

import { TaskSourceError, type RemoteTaskDetail, type RemoteTaskRef } from "../../types.js";

export const ITEM_TYPES = [
  { id: "story", label: "需求" },
  { id: "task", label: "任务" },
  { id: "bug", label: "缺陷" },
] as const;

export type ItemType = (typeof ITEM_TYPES)[number]["id"];

/** 工作项类型 → 列表/详情工具名。 */
const TOOLS: Record<ItemType, string> = {
  story: "stories_get",
  task: "tasks_get",
  bug: "bugs_get",
};

/**
 * 工作项类型 → 待办列表工具名。
 *
 * 实测（2026-09-16）：三个待办工具的入参**只有 workspace_id**，
 * limit / page / owner / name / with_v_status 一律被拒
 * （「参数X不存在于工具user_todo_stories_get的参数定义中」）。
 * 因此待办模式只能全量拉取后本地分页，且状态本身就是中文。
 */
const TOOLS_TODO: Record<ItemType, string> = {
  story: "user_todo_stories_get",
  task: "user_todo_tasks_get",
  bug: "user_todo_bugs_get",
};

export function isItemType(v: string): v is ItemType {
  return ITEM_TYPES.some((t) => t.id === v);
}

/**
 * 取列表工具名。
 *
 * @param onlyTodo true → 待办接口；false → 常规接口。
 * 详情（fetchTask）恒用常规接口：待办接口不返回 description 与 detail_link。
 */
export function toolFor(itemType: string, onlyTodo = false): string {
  if (!isItemType(itemType)) {
    throw new TaskSourceError("invalid_item_type", `unsupported TAPD item type: ${itemType}`);
  }
  return onlyTodo ? TOOLS_TODO[itemType] : TOOLS[itemType];
}

/** 标题字段：bug 用 title，其余用 name。 */
export function pickTitle(row: Record<string, unknown>, itemType: string): string {
  const key = itemType === "bug" ? "title" : "name";
  const v = row[key];
  return typeof v === "string" ? v : "";
}

/** 关键字搜索参数名：bug 用 title，其余用 name。 */
export function keywordField(itemType: string): string {
  return itemType === "bug" ? "title" : "name";
}

/**
 * 处理人字段名。
 *
 * 实测：`owner` 在 bugs_get 的参数定义里**不存在**，传入会报
 * 「参数owner不存在于工具bugs_get的参数定义中」并返回错误文本（HTTP 仍 200）。
 * bug 的处理人字段是 `current_owner`（label=处理人）。
 */
export function ownerField(itemType: string): string {
  return itemType === "bug" ? "current_owner" : "owner";
}

/**
 * 取处理人账号名。
 *
 * 字段同样按类型区分（bug 是 current_owner），且常为空（未分配）。
 * 空值返回 undefined —— 调用方据此跳过参与者回填。
 */
export function pickOwner(row: Record<string, unknown>, itemType: string): string | undefined {
  const raw = row[ownerField(itemType)];
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  // TAPD 多人字段形如 `wlleiiwang;zarekzhang;`（分号分隔）。
  // 参与人回填只认单个账号名，取第一个非空段。
  const first = raw
    .split(";")
    .map((s) => s.trim())
    .find(Boolean);
  return first;
}

/**
 * 是否下发 with_v_status（返回中文状态）。
 *
 * 实测：仅 stories_get 支持。bugs_get / tasks_get 传入会被服务端直接拒绝，
 * 返回「参数不存在于工具X的参数定义中」文本而非数据 —— 若下发会把配置错误
 * 伪装成「0 条结果」，故严格按类型区分。
 */
export function supportsVStatus(itemType: string): boolean {
  return itemType === "story";
}

/**
 * 详情页 URL。
 *
 * 优先用接口自带的 `detail_link`（story / bug 列表与详情都返回）。
 * 缺失时按站点根构造，路径固定为 `/tapd_fe/{workspace_id}/{type}/detail/{id}`：
 *
 *   - task 接口**从不返回** detail_link（列表与详情都没有），必须构造；
 *   - 待办接口（user_todo_*_get）三类都不返回，也要构造。
 *
 * **不要用工作空间短名（pretty_name）拼路径**：实测用 pretty_name 拼出的
 * `/{pretty_name}/{workspace_id}/{type}/detail/{id}` 返回 302 跳登录页，
 * 而 `/tapd_fe/{workspace_id}/{type}/detail/{id}` 返回 200。`tapd_fe` 是固定路由段，
 * 与 pretty_name 无关，且对所有 workspace 一致。
 */
export function buildUrl(
  row: Record<string, unknown>,
  itemType: string,
  siteBaseUrl: string,
  scope: string,
  _prettyName?: string,
): string | undefined {
  const link = row["detail_link"];
  if (typeof link === "string" && link) return link;
  if (!isItemType(itemType)) return undefined;
  const id = typeof row["id"] === "string" ? (row["id"] as string) : String(row["id"] ?? "");
  if (!id) return undefined;
  return `${stripSlash(siteBaseUrl)}/tapd_fe/${scope}/${itemType}/detail/${id}`;
}

/**
 * 解析展示用状态：优先中文，缺失再回落到原始码。
 *
 * 实测三类接口的能力不一致：
 *   - story：支持 `with_v_status="1"`，响应直接带 `v_status`（中文，如「未开始」）
 *   - task / bug：**不支持** with_v_status（传入会被拒绝），只有 `status` 英文码
 *     （如 `status_3` / `new`）
 * 因此 task / bug 需要另取状态映射表：
 *   `tapd_field_detail_get(object_type, field_names="status")` 返回
 *   `options: { "new": "新", "in_progress": "接受/处理", ... }`。
 */
export function resolveStatus(
  row: Record<string, unknown>,
  statusLabelMap?: Readonly<Record<string, string>>,
): string | undefined {
  const vStatus = str(row["v_status"]);
  if (vStatus) return vStatus;
  const code = str(row["status"]);
  if (!code) return undefined;
  return statusLabelMap?.[code] ?? code;
}

/**
 * 取行内的 workspace_id。
 *
 * 跨项目待办（user_todo_*_get 不传 workspace_id）时每行自带 workspace_id，
 * 但实测它是 **number**（如 12345678），而请求级 scope 是 string。
 * 只认 string 会取不到 → 详情页 URL 拼出 `tapd_fe//story/...` 这种空段路径。
 */
export function rowScope(row: Record<string, unknown>, fallback: string): string {
  const v = row["workspace_id"];
  if (typeof v === "string" && v) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return fallback;
}

export function toRef(
  row: Record<string, unknown>,
  itemType: string,
  siteBaseUrl: string,
  scope: string,
  prettyName?: string,
  statusLabelMap?: Readonly<Record<string, string>>,
): RemoteTaskRef {
  const id = row["id"];
  return {
    externalId: typeof id === "string" ? id : String(id ?? ""),
    itemType,
    title: pickTitle(row, itemType),
    url: buildUrl(row, itemType, siteBaseUrl, scope, prettyName),
    status: resolveStatus(row, statusLabelMap),
    updatedAt: str(row["modified"]) ?? str(row["created"]),
    owner: pickOwner(row, itemType),
    scope,
  };
}

export function toDetail(
  row: Record<string, unknown>,
  itemType: string,
  siteBaseUrl: string,
  scope: string,
  prettyName: string,
  statusLabelMap?: Readonly<Record<string, string>>,
): RemoteTaskDetail {
  const ref = toRef(row, itemType, siteBaseUrl, scope, prettyName, statusLabelMap);
  const body = typeof row["description"] === "string" ? row["description"] : "";
  const warnings: string[] = [];
  if (!body) warnings.push("远端正文为空");
  if (!ref.url) warnings.push("未能解析详情页地址");
  return { ...ref, body, fidelity: "lossless", warnings };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function stripSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
