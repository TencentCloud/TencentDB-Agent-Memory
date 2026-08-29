/**
 * mem:create-task — 从当前会话上下文生成 Task 并绑定到本 session。
 *
 * 交互（对齐 TAPD 需求"用户确认"闸门）：
 *
 *   ┌ session 未绑真实 task：
 *   │    无参数 → LLM 生成 title+desc → 直接落库+绑定（无需 confirm）
 *   │    有参数 → title = 用户参数(≤40 字)，LLM 只生成 desc → 直接落库+绑定
 *   │            LLM 失败 → 降级：desc 留空，task 照样落库
 *   │
 *   ├ session 已绑真实 task：
 *   │    生成新 draft → 写入 pending-store（TTL 5 分钟）→ 返"预览 + 三选一引导"：
 *   │      1) mem:create-task confirm — 覆盖绑定，新建
 *   │      2) mem:update-task [新描述] — 继续复用当前 Task 只更新描述
 *   │      3) mem:create-task cancel — 撤销
 *   │
 *   ├ `mem:create-task confirm`：
 *   │    从 pending 取出 draft → 创建新 task → 覆盖 session 绑定 → 清 pending
 *   │
 *   └ `mem:create-task cancel`：
 *        清 pending，不落库
 *
 * 参数解析：
 *   - `confirm` / `cancel`（大小写不敏感）单独出现视为子命令
 *   - 其它任意 args 一律作为 lockedTitle（首次调用的 title 提示）
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import {
  cancelPendingTaskAction,
  confirmPendingTaskAction,
  createTaskFromSession,
} from "../../routes/session-task.js";

const DESC_PREVIEW_LEN = 200;
const TITLE_MAX_LEN = 40;

function trimDesc(desc: string | undefined | null): string {
  const text = desc ?? "";
  if (text.length === 0) return "(空)";
  return text.length > DESC_PREVIEW_LEN ? `${text.slice(0, DESC_PREVIEW_LEN)}...` : text;
}

function truncateTitle(raw: string): string {
  const s = raw.trim();
  return s.length > TITLE_MAX_LEN ? s.slice(0, TITLE_MAX_LEN) : s;
}

/** 判定 args 是否是 confirm / cancel 子命令。仅当整体 trim 后严格等于时命中。 */
function parseSubcommand(args: string): "confirm" | "cancel" | null {
  const s = args.trim().toLowerCase();
  if (s === "confirm") return "confirm";
  if (s === "cancel") return "cancel";
  return null;
}

export async function executeCreateTask(ctx: MemCommandContext): Promise<MemCommandResult> {
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

  // ── confirm 分支 ────────────────────────────────────────────────────────
  if (subcommand === "confirm") {
    const result = await confirmPendingTaskAction({
      sessionKey: ctx.sessionKey,
      agentSource: ctx.agentSource,
      config: ctx.config,
      spaceId: ctx.spaceId,
    });

    if (result.noPending) {
      return finalize(
        `⚠️ 没有待确认的 Task 操作（可能已超时或被取消）。请重新执行 \`mem:create-task [标题]\`。`,
        false,
        { reason: "no_pending" },
      );
    }
    if (!result.success) {
      return finalize(
        `❌ Task 创建失败：${result.error ?? "unknown error"}`,
        false,
        { reason: "create_failed", detail: result.error },
      );
    }

    const prevLine = result.previousTaskId
      ? `\n\n（已解除原绑定 Task \`${result.previousTaskId}\`）`
      : "";
    return finalize(
      `✅ 已创建并绑定新 Task。\n\n` +
        `- **标题**：${result.title}\n` +
        `- **状态**：${result.status ?? "running"}\n` +
        `- **描述**：${trimDesc(result.description)}\n` +
        `- **Task ID**：\`${result.taskId}\`${prevLine}`,
      true,
      {
        task_id: result.taskId,
        title: result.title,
        description: result.description,
        status: result.status,
        ...(result.previousTaskId ? { previous_task_id: result.previousTaskId } : {}),
        ...(result.error ? { bind_warning: result.error } : {}),
      },
    );
  }

  // ── cancel 分支 ─────────────────────────────────────────────────────────
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
      ? `✅ 已取消待确认的 Task 操作。`
      : `ℹ️ 当前没有待确认的 Task 操作。`;
    return finalize(msg, true, { cancelled: result.cancelled ?? false });
  }

  // ── 首次调用分支 ────────────────────────────────────────────────────────

  const lockedTitle = rawArgs.length > 0 ? truncateTitle(rawArgs) : undefined;

  if (recentMessages.length === 0) {
    return finalize(
      `⚠️ 当前请求未携带对话消息，\`mem:create-task\` 需要最近对话作为上下文才能生成 Task。` +
        `\n\n提示：请先与 AI 进行几轮对话后再执行此命令。`,
      false,
      { reason: "no_recent_messages" },
    );
  }

  const result = await createTaskFromSession({
    sessionKey: ctx.sessionKey,
    agentSource: ctx.agentSource,
    config: ctx.config,
    spaceId: ctx.spaceId,
    recentMessages,
    ...(lockedTitle ? { lockedTitle, hint: rawArgs } : {}),
  });

  // 落库失败
  if (!result.success) {
    const detail = result.error ?? "unknown error";
    const hintLine = lockedTitle
      ? ""
      : "\n\n你可以：\n1. 稍后重试\n2. `mem:create-task <你的标题>` 手动指定标题（LLM 只生成描述，即便失败也会用空描述兜底）";
    return finalize(
      `❌ Task 创建失败：${detail}${hintLine}`,
      false,
      { reason: "create_failed", detail },
    );
  }

  // 已绑分支：pending 预览
  if (result.pending && result.pending.kind === "create") {
    const p = result.pending;
    const currentLine = p.currentTaskTitle
      ? `\`${p.currentTaskId}\`「${p.currentTaskTitle}」`
      : `\`${p.currentTaskId}\``;
    return finalize(
      `⚠️ 当前会话已绑定 Task ${currentLine}。\n\n` +
        `**新 Task 预览**\n` +
        `- 标题：${p.draftTitle}\n` +
        `- 描述：${trimDesc(p.draftDescription)}\n\n` +
        `请选择下一步：\n` +
        `1. \`mem:create-task confirm\` — 覆盖当前绑定，创建新 Task\n` +
        `2. \`mem:update-task\` 或 \`mem:update-task <新描述>\` — 继续复用当前 Task，只更新描述（不新建）\n` +
        `3. \`mem:create-task cancel\` — 取消，不做任何改动`,
      true,
      {
        reason: "pending",
        pending: {
          kind: "create",
          draft_title: p.draftTitle,
          draft_description: p.draftDescription,
          current_task_id: p.currentTaskId,
          ...(p.currentTaskTitle ? { current_task_title: p.currentTaskTitle } : {}),
        },
      },
    );
  }

  // 未绑分支：直接落库成功
  return finalize(
    `✅ Task 已创建并绑定到本会话。\n\n` +
      `- **标题**：${result.title}\n` +
      `- **状态**：${result.status ?? "running"}\n` +
      `- **描述**：${trimDesc(result.description)}\n` +
      `- **Task ID**：\`${result.taskId}\`\n\n` +
      `后续可用 \`mem:update-task\` 追加进度。`,
    true,
    {
      task_id: result.taskId,
      title: result.title,
      description: result.description,
      status: result.status,
      ...(result.error ? { bind_warning: result.error } : {}),
    },
  );
}
