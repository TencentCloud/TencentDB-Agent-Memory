/** Trusted, metadata-only L0 aggregation for the Panel topology service. */
import { z } from "zod";

import type { IMemoryStore, L0TaskActivityResult } from "../core/store/types.js";
import { errorEnvelope, successEnvelope } from "./v2-router.js";
import type { ApiResponseEnvelope, V2AuthContext } from "./v2-schemas.js";

export const TASK_ACTIVITY_MAX_TASKS = 100;

export const taskActivityRequestSchema = z.object({
  team_id: z.string().trim().min(1),
  task_ids: z.array(z.string().trim().min(1)).min(1).max(TASK_ACTIVITY_MAX_TASKS),
  user_id: z.string().trim().min(1).optional(),
  time_start_ms: z.number().int().nonnegative().optional(),
  time_end_ms: z.number().int().nonnegative().optional(),
}).refine(
  (value) => value.time_start_ms === undefined || value.time_end_ms === undefined || value.time_start_ms <= value.time_end_ms,
  { message: "time_start_ms must be less than or equal to time_end_ms" },
);

type TaskActivityDeps = {
  getStore?: () => IMemoryStore | undefined;
  resolveStore?: (serviceId: string) => Promise<{ store: IMemoryStore | undefined }>;
};

export async function handleTaskActivityAggregate(
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: unknown,
): Promise<ApiResponseEnvelope> {
  const parsed = taskActivityRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorEnvelope(400, parsed.error.issues.map((issue) => issue.message).join("; "), requestId);
  }

  const taskDeps = deps as TaskActivityDeps;
  const store = taskDeps.resolveStore
    ? (await taskDeps.resolveStore(auth.serviceId)).store
    : taskDeps.getStore?.();
  if (!store?.aggregateL0TaskActivity) {
    return errorEnvelope(503, "Task activity aggregation is unavailable", requestId);
  }

  const taskIds = [...new Set(parsed.data.task_ids)];
  const data = await store.aggregateL0TaskActivity({
    teamId: parsed.data.team_id,
    taskIds,
    userId: parsed.data.user_id,
    timeStartMs: parsed.data.time_start_ms,
    timeEndMs: parsed.data.time_end_ms,
  });
  return successEnvelope<L0TaskActivityResult>(data, requestId);
}

type RouteHandler = (
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: unknown,
) => Promise<ApiResponseEnvelope>;

export function makeTaskActivityRouteTable(): Record<string, RouteHandler> {
  return { "/v3/topology/task-activity/aggregate": handleTaskActivityAggregate };
}
