/**
 * /api/v1/task/list-with-agents —— Task 聚合接口（Panel 层 N+1 消除）。
 *
 * 为什么需要这个接口：
 *   内核 `task/list` 只返回 task 本体，不含 linked_agents。
 *   前端原先需要逐条调 `task/get` + `task-agent/list`（2N+1 次），
 *   10 个 task = 21 次请求，严重 N+1。
 *
 * Panel 层聚合：
 *   1. 调一次内核 `task/list` 拿 task 列表（含分页）
 *   2. 并行调 N 次 `task-agent/list` 补齐 linked_agents
 *   3. 一次返回给前端 `{ items: TaskWithAgents[], total, limit, offset }`
 *
 * 网络往返在 Panel 层内部消化（同主机，延迟极低），前端只发 1 次请求。
 *
 */
import type { Hono, Context } from "hono";
import type { PanelDeps } from "../../panel-deps.js";
import type { MetaCallContext } from "../../kernel/types.js";
import type { MetaEnvelope } from "../../kernel/envelope.js";
import { respondEnvelope, respondControlError } from "../envelope.js";
import { validatePanelMetaHeaders } from "../middleware/validate-panel-headers.js";

function buildCtx(c: Context): MetaCallContext {
  const panelMeta = c.get("panelMeta");
  return {
    instanceId: panelMeta.instanceId,
    gatewayEndpoint: panelMeta.gatewayEndpoint,
    gatewayApiKey: panelMeta.gatewayApiKey,
    userKey: panelMeta.userKey,
    reqId: c.get("reqId"),
  };
}

function okEnvelope<T>(c: Context, data: T): MetaEnvelope<T> {
  return { code: 0, message: "ok", request_id: c.get("reqId") ?? "", data };
}

// ── 类型定义 ──────────────────────────────────────────────────────────────────

interface TaskEntity {
  task_id: string;
  team_id: string;
  title: string;
  description?: string;
  status: string;
  source_type?: string;
  risk_level?: string;
  created_at: string;
  updated_at: string;
}

interface TaskAgent {
  agent_id: string;
  task_id: string;
  team_id: string;
  status: string;
  created_at: string;
}

interface TaskWithAgents extends TaskEntity {
  agents: TaskAgent[];
}

interface ListWithAgentsBody {
  team_id: string;
  limit?: number;
  offset?: number;
  status?: string;
  title?: string;
}

// ── 路由注册 ──────────────────────────────────────────────────────────────────

export function registerTaskRoutes(api: Hono, deps: PanelDeps): void {
  /**
   * POST /api/v1/task/list-with-agents
   *
   * 聚合 task/list + 批量 task-agent/list，一次返回 task 列表及其关联 agents。
   * 前端只调这一个接口，不再需要 N+1。
   */
  api.post(
    "/task/list-with-agents",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const body = await c.req
        .json<ListWithAgentsBody>()
        .catch(() => ({ team_id: "" }) as ListWithAgentsBody);
      const { team_id: teamId, limit, offset, status, title } = body;

      if (!teamId) {
        return respondControlError(c, 400, "MISSING_TEAM_ID");
      }

      const ctx = buildCtx(c);

      // 1. 调一次 task/list 拿 task 列表（含分页）
      const listPayload: Record<string, unknown> = { team_id: teamId };
      if (typeof limit === "number" && limit > 0)
        listPayload.limit = Math.min(limit, 200);
      if (typeof offset === "number" && offset >= 0)
        listPayload.offset = offset;
      if (status) listPayload.status = status;
      if (title) listPayload.title = title;

      const taskEnv = await deps.metaKernel.invoke(
        "task/list",
        listPayload,
        ctx,
      );

      if (taskEnv.code !== 0) return respondEnvelope(c, taskEnv);

      const taskData = taskEnv.data as {
        items?: TaskEntity[];
        total?: number;
        limit?: number;
        offset?: number;
      } | null;

      const tasks = taskData?.items ?? [];
      const total = taskData?.total ?? tasks.length;

      // 2. 并行调 N 次 task-agent/list 补齐 linked_agents
      //    分批并行（每批 20 个），避免 N 很大时压垮内核连接池。
      //    读读不冲突（SQLite WAL / MongoDB），但连接数/线程数有上限。
      const BATCH_SIZE = 20;
      const agentsResults: TaskAgent[][] = [];
      for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
        const batch = tasks.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map((t) =>
            deps.metaKernel
              .invoke("task-agent/list", { task_id: t.task_id }, ctx)
              .then((env) =>
                env.code === 0 && env.data
                  ? ((env.data as { items?: TaskAgent[] }).items ?? [])
                  : [],
              )
              .catch(() => [] as TaskAgent[]),
          ),
        );
        agentsResults.push(...batchResults);
      }

      // 3. 合并返回
      const items: TaskWithAgents[] = tasks.map((t, i) => ({
        ...t,
        agents: agentsResults[i] ?? [],
      }));

      return c.json(
        okEnvelope(c, {
          items,
          total,
          limit: (listPayload.limit as number) ?? 50,
          offset: (listPayload.offset as number) ?? 0,
        }),
      );
    },
  );
}
