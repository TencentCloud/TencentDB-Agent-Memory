/**
 * mem:update-task — 更新已绑定 Task。
 *
 * 交互（每次都需要用户确认）：
 *
 *   ┌ session 未绑 → 拦截，引导 mem:create-task
 *   ├ 首次调用（无 confirm/cancel 子命令）：
 *   │    有参数 → description 直接替换（跳 LLM）→ 写 pending → 预览
 *   │    无参数 → LLM diff 生成新 desc + status 建议 → 写 pending → 预览
 *   │            LLM 判 changed=false → 返"无需更新"，不写 pending
 *   ├ `mem:update-task confirm` → 从 pending 取 → updateTask（含 status 透传） → 清 pending
 *   └ `mem:update-task cancel`  → 清 pending
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import {
  cancelPendingTaskAction,
  confirmPendingTaskAction,
  updateTaskFromSession,
} from "../../routes/session-task.js";

const DESC_PREVIEW_LEN = 200;

function trimDesc(desc: string | undefined | null): string {
  const text = desc ?? "";
  if (text.length === 0) return "(空)";
  return text.length > DESC_PREVIEW_LEN ? `${text.slice(0, DESC_PREVIEW_LEN)}...` : text;
}

function parseSubcommand(args: string): "confirm" | "cancel" | null {
  const s = args.trim().toLowerCase();
  if (s === "confirm") return "confirm";
  if (s === "cancel") return "cancel";
  return null;
}

export async function executeUpdateTask(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;
  const recentMessages = ctx.bodyMessages ?? [];
  const rawArgs = (ctx.args ?? "").trim();

  const finalize = (
    messageText: string,
    success: boolean,
    data: Record<string, unknown>,
  ): MemCommandResult => {
    const response = buildMemResponse(messageText, {
      protocol: ctx.protocol,
      stream: ctx.stream,
      requestId,
      thinking: ctx.thinking,
    });
    return { success, messageText, data, response };
  };

  const subcommand = parseSubcommand(rawArgs);

  // ── confirm ─────────────────────────────────────────────────────────────
  if (subcommand === "confirm") {
    const result = await confirmPendingTaskAction({
      sessionKey: ctx.sessionKey,
      agentSource: ctx.agentSource,
      config: ctx.config,
      spaceId: ctx.spaceId,
    });

    if (result.noPending) {
      return finalize(
        `⚠️ 没有待确认的 Task 更新（可能已超时或被取消）。请重新执行 \`mem:update-task [补充]\`。`,
        false,
        { reason: "no_pending" },
      );
    }
    if (!result.success) {
      return finalize(
        `❌ Task 更新失败：${result.error ?? "unknown error"}`,
        false,
        { reason: "update_failed", detail: result.error },
      );
    }

    return finalize(
      `✅ Task 已更新。\n\n` +
        `- **标题**：${result.title}（不可变）\n` +
        `- **状态**：${result.status ?? "running"}\n` +
        `- **新描述**：${trimDesc(result.description)}\n` +
        `- **Task ID**：\`${result.taskId}\``,
      true,
      {
        task_id: result.taskId,
        title: result.title,
        description: result.description,
        status: result.status,
      },
    );
  }

  // ── cancel ──────────────────────────────────────────────────────────────
  if (subcommand === "cancel") {
    const result = await cancelPendingTaskAction({
      sessionKey: ctx.sessionKey,
      agentSource: ctx.agentSource,
      config: ctx.config,
      spaceId: ctx.spaceId,
    });
    if (!result.success) {
      return finalize(
        `⚠️ 取消失败：${result.error ?? "unknown"}`,
        false,
        { reason: "cancel_failed", detail: result.error },
      );
    }
    const msg = result.cancelled
      ? `✅ 已取消待确认的 Task 更新。`
      : `ℹ️ 当前没有待确认的 Task 更新。`;
    return finalize(msg, true, { cancelled: result.cancelled ?? false });
  }

  // ── 首次调用 ────────────────────────────────────────────────────────────

  const directDescription = rawArgs.length > 0 ? rawArgs : undefined;

  if (!directDescription && recentMessages.length === 0) {
    return finalize(
      `⚠️ 当前请求未携带对话消息，无参数版 \`mem:update-task\` 需要最近对话作为上下文。` +
        `\n\n你可以直接：\`mem:update-task <你的补充描述>\` 手动指定新描述。`,
      false,
      { reason: "no_recent_messages" },
    );
  }

  const result = await updateTaskFromSession({
    sessionKey: ctx.sessionKey,
    agentSource: ctx.agentSource,
    config: ctx.config,
    spaceId: ctx.spaceId,
    recentMessages,
    ...(directDescription ? { directDescription, hint: rawArgs } : {}),
  });

  // 未绑
  if (!result.success && result.error?.includes("no task bound")) {
    return finalize(
      `⚠️ 当前 session 尚未绑定 Task。请先执行 \`mem:create-task\` 创建一个 Task 再来更新。`,
      false,
      { reason: "no_task_bound" },
    );
  }

  // 跨用户更新：kernel 不支持，proxy 侧提前拒绝并建议新建
  if (!result.success && result.error === "not_creator") {
    return finalize(
      `❌ 无法更新：该 Task 不是你创建的，当前不支持跨用户修改。\n\n` +
        `如果你需要基于当前会话新建一个属于你的 Task，请使用 \`mem:create-task\`。`,
      false,
      { reason: "not_creator" },
    );
  }

  // 其它错误
  if (!result.success) {
    const detail = result.error ?? "unknown error";
    const hintLine = directDescription
      ? ""
      : "\n\n你可以：\n1. 稍后重试\n2. `mem:update-task <你的补充>` 手动指定新描述";
    return finalize(
      `❌ Task 更新失败：${detail}${hintLine}`,
      false,
      { reason: "update_failed", detail },
    );
  }

  // LLM 判无需更新
  if (result.noUpdateNeeded) {
    return finalize(
      `ℹ️ Task 无需更新 —— 最近对话未产生新的进展或范围变化。\n\n` +
        `Task ID: \`${result.taskId}\`\n` +
        `可稍后再次执行 \`mem:update-task [补充]\` 触发判断，或直接带参数强制更新。`,
      true,
      { reason: "no_update_needed", task_id: result.taskId },
    );
  }

  // 首次调用：pending 预览
  if (result.pending && result.pending.kind === "update") {
    const p = result.pending;
    const statusLine = p.statusSuggestion
      ? `\n- 状态建议：${p.statusSuggestion}`
      : "";
    return finalize(
      `📝 Task「${p.currentTitle ?? p.taskId}」更新预览：\n\n` +
        `- 新描述：${trimDesc(p.draftDescription)}${statusLine}\n\n` +
        `回复 \`mem:update-task confirm\` 确认，或 \`mem:update-task cancel\` 取消。`,
      true,
      {
        reason: "pending",
        pending: {
          kind: "update",
          task_id: p.taskId,
          draft_description: p.draftDescription,
          ...(p.statusSuggestion ? { status_suggestion: p.statusSuggestion } : {}),
          ...(p.currentTitle ? { current_title: p.currentTitle } : {}),
          ...(p.currentStatus ? { current_status: p.currentStatus } : {}),
        },
      },
    );
  }

  // 兜底（理论走不到）：返回当前状态
  return finalize(
    `ℹ️ Task 无变更。\n\nTask ID: \`${result.taskId}\``,
    true,
    { task_id: result.taskId },
  );
}
