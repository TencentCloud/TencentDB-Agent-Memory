import { z } from "zod";

const queryInt = (min: number, max: number, fallback: number) => z.preprocess(
  (value) => value === undefined || value === "" ? fallback : Number(value),
  z.number().int().min(min).max(max),
);

export const memoryGenerationLogListSchema = z.strictObject({
  layer: z.enum(["l1", "l2", "l3"]).optional(),
  status: z.enum(["succeeded", "failed"]).optional(),
  start_time: z.string().datetime({ offset: true }).optional(),
  end_time: z.string().datetime({ offset: true }).optional(),
  limit: queryInt(1, 100, 20),
  cursor: z.string().min(1).max(512).optional(),
}).superRefine((value, ctx) => {
  if (!!value.start_time !== !!value.end_time) ctx.addIssue({ code: "custom", message: "start_time and end_time must be provided together" });
  if (value.start_time && value.end_time) {
    const start = Date.parse(value.start_time);
    const end = Date.parse(value.end_time);
    if (start > end) ctx.addIssue({ code: "custom", path: ["start_time"], message: "start_time must not be after end_time" });
    if (end - start > 90 * 24 * 60 * 60 * 1000) ctx.addIssue({ code: "custom", path: ["end_time"], message: "time range must not exceed 90 days" });
  }
});

export const memoryGenerationLogGetSchema = z.strictObject({
  log_id: z.string().trim().min(1).optional(),
  memory_id: z.string().trim().min(1).optional(),
  layer: z.enum(["l1", "l2", "l3"]).optional(),
}).superRefine((value, ctx) => {
  if (!!value.log_id === !!value.memory_id) ctx.addIssue({ code: "custom", message: "provide exactly one of log_id or memory_id" });
  if (value.memory_id && !value.layer) ctx.addIssue({ code: "custom", path: ["layer"], message: "layer is required with memory_id" });
});
