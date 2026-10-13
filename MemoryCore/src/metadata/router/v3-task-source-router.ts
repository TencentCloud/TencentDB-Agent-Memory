/**
 * v3 Task 外部来源路由（/v3/task-source/*，5 接口）。
 *
 * 对应设计文档 §5.2。dispatch 模式镜像 v3-meta-router：
 *   - 仅 POST，前缀 /v3/task-source
 *   - 复用同一套 x-tdai-user-key 用户鉴权
 *   - MetadataError / TaskSourceError → envelope code
 *
 * **凭据注入方式**：用户在 Panel 上手工填入令牌（太湖统一认证令牌 / TAPD 个人令牌），
 * 前端随请求体 `credential` 字段提交，Panel 薄转发到此。
 * Core **不落库、不写日志、不回吐** —— 令牌用完即弃，请求结束即不再持有。
 */

import type * as http from "node:http";
import type { ZodType } from "zod";
import {
  successEnvelope,
  errorEnvelope,
  resolveRequestId,
} from "../../gateway/v2-router.js";
import { formatZodError, type ApiResponseEnvelope } from "../../gateway/v2-schemas.js";
import type { Logger } from "../../core/types.js";
import { MetadataService, MetadataError } from "../service/metadata-service.js";
import { authenticateV3, extractUserKeyHeader, type V3AuthContext } from "./auth.js";
import { extractInstanceId } from "./instance.js";
import * as S from "./v3-meta-schemas.js";
import {
  TaskSourceError,
  TaskSourceRegistry,
  type SourceCredential,
} from "../../task-source/index.js";
import { TaskSourceImportService } from "../../task-source/import-service.js";

export const V3_TASK_SOURCE_PREFIX = "/v3/task-source";
const TAG = "[TASK-SOURCE-V3]";

/**
 * 从请求体解析用户提交的令牌。
 *
 * 支持两种（打到同一端点，仅 header 名不同）：
 *   - bearer：太湖统一认证令牌
 *   - custom：TAPD 个人令牌（走 extra.header 指定的 header）
 * 令牌只在这条请求的内存里存在，不落库、不写日志。
 */
function parseCredential(body: unknown): SourceCredential | null {
  if (!body || typeof body !== "object") return null;
  const cred = (body as { credential?: unknown }).credential;
  if (!cred || typeof cred !== "object") return null;
  const { kind, secret, extra } = cred as {
    kind?: unknown;
    secret?: unknown;
    extra?: unknown;
  };
  if (typeof secret !== "string" || !secret.trim()) return null;
  if (kind !== "bearer" && kind !== "custom" && kind !== "basic") return null;
  return {
    kind,
    secret: secret.trim(),
    extra: extra && typeof extra === "object" ? (extra as Record<string, unknown>) : undefined,
  };
}

export interface V3TaskSourceRouterDeps {
  getMetadataService: (
    instanceId: string,
  ) => MetadataService | undefined | Promise<MetadataService | undefined>;
  logger: Logger;
}

type Ctx = V3AuthContext;
type Handler = (
  body: unknown,
  ctx: Ctx,
  svc: MetadataService,
  requestId: string,
  cred: SourceCredential,
) => Promise<ApiResponseEnvelope>;

function bind<S2 extends ZodType>(
  schema: S2,
  fn: (
    data: S2["_output"],
    ctx: Ctx,
    svc: MetadataService,
    cred: SourceCredential,
  ) => Promise<unknown>,
): Handler {
  return async (body, ctx, svc, requestId, cred) => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
    const data = await fn(parsed.data as S2["_output"], ctx, svc, cred);
    return successEnvelope(data, requestId);
  };
}

function serviceFor(svc: MetadataService): TaskSourceImportService {
  return new TaskSourceImportService(svc);
}

const routeTable: Record<string, Handler> = {
  [`${V3_TASK_SOURCE_PREFIX}/providers`]: bind(S.taskSourceProvidersSchema, async (d, c, s) => {
    // 门控：caller 必须是该 team 的 active member。
    await s.assertExternalTaskImportAllowed(d.team_id, c);
    return { providers: TaskSourceRegistry.list() };
  }),

  [`${V3_TASK_SOURCE_PREFIX}/workspaces`]: bind(S.taskSourceWorkspacesSchema, async (d, c, s) => {
    await s.assertExternalTaskImportAllowed(d.team_id, c);
    const provider = TaskSourceRegistry.get(d.provider_id);
    const tctx = TaskSourceRegistry.contextFor(d.provider_id, d.credential);
    return { workspaces: await provider.listWorkspaces(tctx) };
  }),

  [`${V3_TASK_SOURCE_PREFIX}/candidates`]: bind(S.taskSourceCandidatesSchema, async (d, c, s) => {
    await s.assertExternalTaskImportAllowed(d.team_id, c);
    const provider = TaskSourceRegistry.get(d.provider_id);
    const tctx = TaskSourceRegistry.contextFor(d.provider_id, d.credential);
    const page = await provider.listCandidates(tctx, {
      scope: d.workspace_id,
      itemTypes: d.item_types,
      keyword: d.keyword,
      owner: d.owner,
      status: d.status,
      page: d.page,
      limit: d.limit,
      onlyTodo: d.only_todo,
    });
    // 内部 RemoteTaskRef 用 camelCase，但 v3 接口对外统一 snake_case
    // （与 meta 其它接口一致，且前端按 snake_case 读取）。
    return {
      items: page.items.map((it) => ({
        external_id: it.externalId,
        item_type: it.itemType,
        title: it.title,
        url: it.url,
        status: it.status,
        updated_at: it.updatedAt,
        scope: it.scope,
      })),
      total: page.total,
      has_more: page.hasMore,
    };
  }),

  [`${V3_TASK_SOURCE_PREFIX}/import`]: bind(S.taskSourceImportSchema, async (d, c, s) => {
    return serviceFor(s).import(
      d.provider_id,
      d.team_id,
      d.items.map((i) => ({ external_id: i.external_id, item_type: i.item_type, scope: i.scope ?? "" })),
      d.credential,
      c,
    );
  }),

};

/** 已注册的路由路径（供测试 / 文档）。 */
export const V3_TASK_SOURCE_ROUTES = Object.keys(routeTable);

function mapTaskSourceError(err: TaskSourceError): number {
  switch (err.code) {
    case "task_source_unauthorized":
      return 401;
    case "task_source_not_found":
    case "remote_task_not_found":
      return 404;
    case "task_source_timeout":
      return 504;
    case "task_source_config_missing":
      return 500;
    default:
      return 400;
  }
}

function mapErrorCode(code: string): number {
  if (code.endsWith("_not_found")) return 404;
  if (code === "permission_denied") return 403;
  return 400;
}

export async function handleV3TaskSourceRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  parseJsonBody: <T>(req: http.IncomingMessage) => Promise<T>,
  sendJson: (res: http.ServerResponse, status: number, body: unknown) => void,
  deps: V3TaskSourceRouterDeps,
): Promise<boolean> {
  if (!pathname.startsWith(V3_TASK_SOURCE_PREFIX) || method !== "POST") return false;
  const handler = routeTable[pathname];
  if (!handler) return false;

  const requestId = resolveRequestId(req.headers as Record<string, string | string[] | undefined>);

  let instanceId: string;
  try {
    instanceId = extractInstanceId(req.headers);
  } catch (err) {
    const code = err instanceof MetadataError ? mapErrorCode(err.code) : 400;
    sendJson(res, code, errorEnvelope(code, err instanceof Error ? err.message : "bad request", requestId));
    return true;
  }

  const svc = await Promise.resolve(deps.getMetadataService(instanceId));
  if (!svc) {
    sendJson(res, 503, errorEnvelope(503, "MetadataService not available", requestId));
    return true;
  }

  const headerUserKey = extractUserKeyHeader(req.headers);
  if (!headerUserKey) {
    sendJson(res, 401, errorEnvelope(401, "unauthorized: missing_user_key", requestId));
    return true;
  }
  const auth = await authenticateV3(headerUserKey, svc);
  if (!auth.ok || !auth.ctx) {
    const status = auth.status ?? 401;
    sendJson(res, status, errorEnvelope(status, `unauthorized: ${auth.reason}`, requestId));
    return true;
  }

  const body = await parseJsonBody(req);
  // providers 不需要令牌（只是列出已启用来源）；其余接口必须有。
  const needsCred = pathname !== `${V3_TASK_SOURCE_PREFIX}/providers`;
  const cred = parseCredential(body);
  if (needsCred && !cred) {
    sendJson(res, 400, errorEnvelope(400, "missing_credential", requestId));
    return true;
  }

  try {
    // providers 分支不需要令牌，用空占位即可（provider 侧不会用到）。
    const effective = cred ?? { kind: "bearer" as const, secret: "" };
    const envelope = await handler(body, auth.ctx, svc, requestId, effective);
    // envelope.code 是业务码（成功为 0），不能直接当 HTTP 状态码用 ——
    // 直接下发会命中 `Invalid status code: 0`。与 v3-meta-router 同一映射规则。
    const httpStatus =
      envelope.code === 0
        ? 200
        : envelope.code >= 400 && envelope.code < 600
          ? envelope.code
          : 200;
    sendJson(res, httpStatus, envelope);
    return true;
  } catch (err) {
    if (err instanceof TaskSourceError) {
      const code = mapTaskSourceError(err);
      deps.logger.warn(`${TAG} ${err.code}: ${err.message}`);
      // 日志只记 code 与 message，绝不记令牌。
      sendJson(res, code, errorEnvelope(code, `${err.code}: ${err.message}`, requestId));
      return true;
    }
    if (err instanceof MetadataError) {
      const code = mapErrorCode(err.code);
      sendJson(res, code, errorEnvelope(code, `${err.code}: ${err.message}`, requestId));
      return true;
    }
    deps.logger.error(`${TAG} unhandled error: ${err instanceof Error ? err.message : String(err)}`);
    sendJson(res, 500, errorEnvelope(500, "internal error", requestId));
    return true;
  }
}
