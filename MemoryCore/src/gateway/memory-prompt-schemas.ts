import { z } from "zod";

const unicodeLength = (value: string): number => Array.from(value).length;
const promptLayerSchema = z.enum(["l1", "l2", "l3"]);
const orderSchema = z.enum(["asc", "desc"]);
const queryInt = (min: number, max: number, fallback: number) => z.preprocess(
  (value) => value === undefined || value === "" ? fallback : Number(value),
  z.number().int().min(min).max(max),
);

const nameSchema = z.string().trim().min(1).refine((value) => unicodeLength(value) <= 100, "must be at most 100 Unicode characters");
const promptSchema = z.string().trim().min(1).refine((value) => unicodeLength(value) <= 10_000, "must be at most 10000 Unicode characters");

export const memoryPromptCreateSchema = z.strictObject({
  name: nameSchema,
  layer: promptLayerSchema,
  prompt: promptSchema,
});

export const memoryPromptUpdateSchema = z.strictObject({
  memory_prompt_id: z.string().trim().min(1),
  name: nameSchema.optional(),
  prompt: promptSchema.optional(),
}).refine((value) => value.name !== undefined || value.prompt !== undefined, {
  message: "name or prompt is required",
});

export const memoryPromptDeleteSchema = z.strictObject({
  memory_prompt_ids: z.array(z.string().trim().min(1)).min(1).max(100).transform((ids) => [...new Set(ids)]),
});

export const memoryPromptGetSchema = z.strictObject({
  memory_prompt_id: z.string().trim().min(1).optional(),
  team_id: z.string().trim().min(1).optional(),
  agent_id: z.string().trim().min(1).optional(),
  layer: promptLayerSchema.optional(),
  limit: queryInt(1, 100, 20),
  offset: queryInt(0, Number.MAX_SAFE_INTEGER, 0),
  time_order: orderSchema.default("desc"),
}).superRefine((value, ctx) => {
  if (value.agent_id && !value.team_id) ctx.addIssue({ code: "custom", path: ["team_id"], message: "team_id is required with agent_id" });
  if ((value.team_id || value.agent_id) && !value.layer) ctx.addIssue({ code: "custom", path: ["layer"], message: "layer is required for effective prompt lookup" });
  if (value.memory_prompt_id && (value.team_id || value.agent_id)) ctx.addIssue({ code: "custom", path: ["memory_prompt_id"], message: "memory_prompt_id mode is exclusive with target lookup" });
});

export const memoryPromptSettingListSchema = z.strictObject({
  memory_prompt_id: z.string().trim().min(1).optional(),
  target_type: z.enum(["instance", "team", "agent"]).optional(),
  team_id: z.string().trim().min(1).optional(),
  agent_id: z.string().trim().min(1).optional(),
  layer: promptLayerSchema.optional(),
  limit: queryInt(1, 100, 20),
  offset: queryInt(0, Number.MAX_SAFE_INTEGER, 0),
  time_order: orderSchema.default("desc"),
}).superRefine((value, ctx) => {
  if (value.agent_id && !value.team_id) {
    ctx.addIssue({ code: "custom", path: ["team_id"], message: "team_id is required with agent_id" });
  }
  if (value.target_type === "instance" && (value.team_id || value.agent_id)) {
    ctx.addIssue({ code: "custom", path: ["target_type"], message: "instance target cannot include team_id or agent_id" });
  }
  if (value.target_type === "team" && value.agent_id) {
    ctx.addIssue({ code: "custom", path: ["agent_id"], message: "team target cannot include agent_id" });
  }
});

export const memoryPromptSetSchema = z.strictObject({
  action: z.enum(["apply", "clear"]),
  memory_prompt_id: z.string().trim().min(1).optional(),
  team_id: z.string().trim().min(1).optional(),
  agent_ids: z.array(z.string().trim().min(1)).min(1).max(100).transform((ids) => [...new Set(ids)]).optional(),
  layer: promptLayerSchema,
}).superRefine((value, ctx) => {
  if (value.action === "apply" && !value.memory_prompt_id) ctx.addIssue({ code: "custom", path: ["memory_prompt_id"], message: "memory_prompt_id is required for apply" });
  if (value.agent_ids && !value.team_id) ctx.addIssue({ code: "custom", path: ["team_id"], message: "team_id is required with agent_ids" });
});

export const memoryPromptLogSchema = z.strictObject({
  memory_prompt_id: z.string().trim().min(1).optional(),
  start_time: z.string().datetime({ offset: true }).optional(),
  end_time: z.string().datetime({ offset: true }).optional(),
  team_id: z.string().trim().min(1).optional(),
  agent_id: z.string().trim().min(1).optional(),
  action: z.enum(["apply", "replace", "clear"]).optional(),
  limit: queryInt(1, 100, 20),
  offset: queryInt(0, Number.MAX_SAFE_INTEGER, 0),
  time_order: orderSchema.default("desc"),
}).superRefine((value, ctx) => {
  if (!!value.start_time !== !!value.end_time) ctx.addIssue({ code: "custom", path: ["start_time"], message: "start_time and end_time must be provided together" });
  if (value.agent_id && !value.team_id) ctx.addIssue({ code: "custom", path: ["team_id"], message: "team_id is required with agent_id" });
  if (!value.memory_prompt_id && !value.team_id && !value.agent_id) ctx.addIssue({ code: "custom", message: "memory_prompt_id or a target condition is required" });
  if (value.start_time && value.end_time) {
    const start = Date.parse(value.start_time);
    const end = Date.parse(value.end_time);
    if (start > end) ctx.addIssue({ code: "custom", path: ["start_time"], message: "start_time must not be after end_time" });
    if (end - start > 90 * 24 * 60 * 60 * 1000) ctx.addIssue({ code: "custom", path: ["end_time"], message: "time range must not exceed 90 days" });
  }
});
