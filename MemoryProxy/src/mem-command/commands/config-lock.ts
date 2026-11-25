/**
 * mem:config-lock — 把当前 session 的 (team, agent, task) 保存为用户级 Session 默认。
 *
 * 对应 PRD TAPD 1070195170 "session 默认配置"的 IDE 命令入口 / 设计文档
 * MemoryProxy/docs/design/2026-10-10-user-session-default-design.md §10 (后期扩展)。
 *
 * 语义:
 *   - 必须 session 已 initialized (有真实 team_id + agent_id) 才可执行;
 *     未初始化 / bypass → 返回提示 "请先完成本次会话的 team/agent 选择"
 *   - task_id 允许为"虚拟 default" (= config.sessionInit.defaultTaskId),
 *     表示"不绑定任何 Task" (对齐 Proxy 现有虚拟值契约,前端面板的 default 项同构)
 *
 * ── 两阶段确认 (PRD: "执行 mem:config-lock 前需展示待保存的配置并让用户确认，
 *    避免误覆盖") ──
 *
 *   仅在**会真正覆盖掉一组不同的旧配置**时才要求确认：
 *
 *     无旧配置                    → 一步落库（没什么可覆盖的，确认是纯噪音）
 *     旧配置与新配置完全相同      → 一步落库（结果无变化，无需打扰）
 *     旧配置存在且与新配置不同    → 展示"待保存 + 将被覆盖的旧值" → 等 confirm
 *
 *   为什么只在第三种情况拦：PRD 同一句里既说"已有配置时直接覆盖"又说"需让用户
 *   确认"，二者只在"覆盖掉不同内容"时才真正冲突。首次设置 / 幂等重跑不拦，
 *   避免每次都多一轮交互（这也是早期两阶段被移除的直接原因）。
 *
 *   子命令（与 create-task / update-task 同款）:
 *     mem:config-lock confirm → 从 pending 取出落库
 *     mem:config-lock cancel  → 清 pending，不落库
 *     pending TTL 5 分钟（pending-store 默认），超时自动失效。
 *
 *   - 覆盖写入 (Core 侧 upsert 语义): 已有默认时直接覆盖, created_at 不变。
 *
 * 调用链:
 *   命令执行时组装 (team_id, agent_id, task_id) → 调 MetadataClient.setUserSessionDefault
 *   → Core v3 /v3/meta/user-session-default/set → service 做交叉校验 (user∈team /
 *   agent∈team / task∈team / status 等) → upsert meta_user_session_defaults。
 *
 * 错误口径:
 *   Core 返的错误 code (permission_denied / entity_not_found / task_inactive 等)
 *   原文透传给用户,避免模糊化 —— 用户能从中直接判断是不是自己的身份变了 / 资源被删了。
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import type { SessionInfo } from "../../session/types.js";
import { buildMemResponse } from "../response-builder.js";
import { getSessionStore } from "../../session/store.js";
import { getMetadataClient } from "../../meta/client.js";
import {
  getPending,
  setPending,
  clearPending,
  makePendingKey,
  type PendingConfigLockDraft,
} from "../pending-store.js";

/** 从 state 读 current session 的真实 team/agent/task + 名字 (已 initialized 情况)。 */
interface CurrentSelection {
  teamId: string;
  teamName: string | null;
  agentId: string;
  agentName: string | null;
  taskId: string;
  taskName: string | null;
  isVirtualDefault: boolean;
}

function readCurrentSelection(
  ctx: MemCommandContext,
): CurrentSelection | { error: string } {
  const store = getSessionStore();
  const compositeKey = `${ctx.agentSource}:${ctx.sessionKey}`;
  const state = store.get(compositeKey);

  if (!state || state.status !== "initialized" || state.bypassed === true) {
    return {
      error:
        "ℹ️ 本次会话尚未完成团队资产选择 (bypass / 未初始化)，无法保存为默认。请先对话一两轮确认 Team/Agent 选择，再执行 `mem:config-lock`。",
    };
  }

  const sessionInfo = state.sessionInfo as SessionInfo | null | undefined;
  if (!sessionInfo) {
    return {
      error: "ℹ️ 本次会话状态异常 (缺 sessionInfo)，无法保存默认。请执行 `mem:session-reset` 重走选择表单后再试。",
    };
  }

  const teamId = sessionInfo.team_id ?? "";
  const agentId = sessionInfo.agent_id ?? "";
  if (!teamId || !agentId) {
    return {
      error:
        "ℹ️ 本次会话缺少 team_id 或 agent_id，无法保存默认。请执行 `mem:session-reset` 重走选择表单。",
    };
  }

  // task_id = defaultTaskId (虚拟值 "default") 表示"不绑定任何 Task" —— 允许保存
  // 为默认 (对齐前端面板的 default 项契约)。
  const rawTaskId = sessionInfo.task_id ?? "";
  const defaultSentinel = ctx.config.sessionInit?.defaultTaskId;
  const isVirtualDefault =
    !!defaultSentinel && !!rawTaskId && rawTaskId === defaultSentinel;
  // 真实 task_id 为空也允许保存为"default (不绑定)" —— header-only client 可能
  // 从未传 task_id, 走到 fastRegister 时 taskId=undefined, 这里兜底成 sentinel。
  const effectiveTaskId = rawTaskId || defaultSentinel || "default";

  // 名字只用于成功后回显展示, 取不到就回退到 id —— 不影响 lock 落库。
  const teamName =
    state.cachedTeams?.find((t) => t.team_id === teamId)?.team_name ?? null;
  const agentName = state.agentDetail?.name ?? null;
  const taskName = isVirtualDefault
    ? null
    : (state.taskDetail?.name ?? null);

  return {
    teamId,
    teamName,
    agentId,
    agentName,
    taskId: effectiveTaskId,
    taskName,
    isVirtualDefault,
  };
}

/** 构造 Core MetadataClient (user key 走 sessionInfo.user_key, 和 session-task 对称)。 */
function makeClient(ctx: MemCommandContext) {
  const sessionInfo = ctx.sessionInfo as Record<string, unknown> | undefined;
  const userKey = (sessionInfo?.user_key as string | undefined) ?? ctx.apiKey ?? "";
  return getMetadataClient(ctx.config.coreSkill, ctx.spaceId, userKey);
}

/**
 * pending 的 key。
 *
 * ⚠️ 必须加 `cfg-lock:` 前缀：session-task 侧的 key 是裸的
 * `team:agent:session`（见 routes/session-task.ts pendingKeyOf），两者在同一
 * session 下会算出**完全相同**的 key。若不隔离，用户先 `mem:create-task` 进
 * pending 再执行 `mem:config-lock`，后者会覆盖掉前者的 task 草稿，导致
 * `mem:create-task confirm` 读到错误 payload。
 */
const PENDING_KEY_PREFIX = "cfg-lock:";

function pendingKeyFor(ctx: MemCommandContext, sel: CurrentSelection): string {
  return (
    PENDING_KEY_PREFIX +
    makePendingKey({
      team_id: sel.teamId,
      agent_id: sel.agentId,
      session_id: ctx.sessionKey,
    })
  );
}

/** 判定 args 是否为 confirm / cancel 子命令（与 create-task 同款，大小写不敏感）。 */
function parseSubcommand(args: string): "confirm" | "cancel" | null {
  const s = (args ?? "").trim().toLowerCase();
  if (s === "confirm") return "confirm";
  if (s === "cancel") return "cancel";
  return null;
}

/** 把三元组渲染成可读的一行文本（确认预览 / 成功回显共用）。 */
function formatTriple(
  sel: Pick<CurrentSelection, "teamId" | "teamName" | "agentId" | "agentName" | "taskId" | "taskName" | "isVirtualDefault">,
): string[] {
  const taskLabel = sel.isVirtualDefault
    ? "default (不绑定任何 Task)"
    : sel.taskName
      ? `${sel.taskName} (${sel.taskId})`
      : sel.taskId;
  return [
    `- **Team**: ${sel.teamName ? `${sel.teamName} (${sel.teamId})` : sel.teamId}`,
    `- **Agent**: ${sel.agentName ? `${sel.agentName} (${sel.agentId})` : sel.agentId}`,
    `- **Task**: ${taskLabel}`,
  ];
}

/** 格式化成功文本 (落库后回显保存了什么，便于用户核对 / 撤销)。 */
function formatSuccess(sel: CurrentSelection): string {
  return [
    "✅ 当前 session 绑定默认配置：",
    "",
    ...formatTriple(sel),
    "",
    "下次新开 Session 将自动使用这组配置，无需再选择。",
    "想解除请执行 `mem:config-unlock`；想换一组请去面板「Agents · Session 默认配置」或重跑 `mem:config-lock`。",
  ].join("\n");
}

/**
 * 格式化"待确认"预览文本 —— PRD 要求的"展示待保存的配置"。
 *
 * 与 formatSuccess 的区别：这里**还没落库**，所以：
 *   - 明确标注"尚未保存"，避免用户误以为已经生效；
 *   - 同时展示将被覆盖的旧配置（这是"避免误覆盖"的信息基础）；
 *   - 给出 confirm / cancel 两条明确出路。
 */
function formatPendingPreview(draft: PendingConfigLockDraft): string {
  const lines: string[] = [
    "⚠️ 即将保存为全局默认配置（**尚未保存**）：",
    "",
    ...formatTriple(draft),
  ];

  if (draft.previous) {
    lines.push("");
    lines.push("**将被覆盖的当前默认配置：**");
    lines.push(`- Team: ${draft.previous.teamId}`);
    lines.push(`- Agent: ${draft.previous.agentId}`);
    lines.push(
      `- Task: ${draft.previous.taskId === "default" ? "default (不绑定任何 Task)" : draft.previous.taskId}`,
    );
  }

  lines.push("");
  lines.push("确认请回复 `mem:config-lock confirm`，取消请回复 `mem:config-lock cancel`。");
  lines.push("（5 分钟内有效，超时后需重新执行 `mem:config-lock`。）");
  return lines.join("\n");
}

/** 统一构造 MemCommandResult，避免每个分支重复写 buildMemResponse。 */
function result(
  ctx: MemCommandContext,
  requestId: string,
  success: boolean,
  messageText: string,
  data?: Record<string, unknown>,
): MemCommandResult {
  return {
    success,
    messageText,
    ...(data ? { data } : {}),
    response: buildMemResponse(messageText, {
      protocol: ctx.protocol,
      stream: ctx.stream,
      requestId,
      thinking: ctx.thinking,
    }),
  };
}

/** 真正落库的一步（confirm 与"无需确认"两个分支共用）。 */
async function applyLock(
  ctx: MemCommandContext,
  requestId: string,
  triple: { teamId: string; agentId: string; taskId: string },
  sel: CurrentSelection,
): Promise<MemCommandResult> {
  try {
    const client = makeClient(ctx);
    await client.setUserSessionDefault(ctx.userId, {
      team_id: triple.teamId,
      agent_id: triple.agentId,
      task_id: triple.taskId,
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const text = [
      "❌ 保存账户级默认失败，当前默认配置未改动。",
      "",
      `原始错误: ${raw}`,
      "",
      "若是 `permission_denied` / `entity_not_found` / `task_inactive` 等，表示 Team/Agent/Task 的身份或归属校验未通过。请检查你是否仍属于该 Team，以及 Agent/Task 是否还在。",
    ].join("\n");
    console.warn(
      `[mem-command:config-lock] setUserSessionDefault failed for user=${ctx.userId} session=${ctx.sessionKey}: ${raw}`,
    );
    return result(ctx, requestId, false, text);
  }

  console.log(
    `[mem-command:config-lock] applied user=${ctx.userId} session=${ctx.sessionKey} ` +
      `team=${triple.teamId} agent=${triple.agentId} task=${triple.taskId}`,
  );

  const successText = formatSuccess(sel);
  return result(ctx, requestId, true, successText, {
    team_id: triple.teamId,
    agent_id: triple.agentId,
    task_id: triple.taskId,
  });
}

export async function executeConfigLock(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;

  const sub = parseSubcommand(ctx.args ?? "");

  // ── confirm / cancel / 首次：都要先拿到当前 session 的真实三元组 ─────────
  //
  // key 里含 team:agent:session（与 setPending 时同构），所以 cancel 必须算出
  // 同一个 key 才能清掉草稿 —— 不能只用 session_id 另建一个 key，否则 cancel
  // 永远清不掉，用户只能干等 5 分钟超时。
  //
  // 代价：session 已 reset / 未初始化时无法主动 cancel（readCurrentSelection 会
  // 报错）。可接受 —— pending 5 分钟自动失效，且未 confirm 就什么都没写入。
  const sel = readCurrentSelection(ctx);
  if ("error" in sel) {
    return result(ctx, requestId, false, sel.error);
  }

  if (sub === "cancel") {
    const had = clearPending(pendingKeyFor(ctx, sel));
    const text = had
      ? "↩️ 已取消，未保存任何默认配置。当前默认配置保持不变。"
      : "ℹ️ 没有待确认的默认配置（可能已确认或已超时），无需取消。";
    return result(ctx, requestId, true, text);
  }

  if (sub === "confirm") {
    // 官方文档语义：confirm 从 pending 取草稿落库。若 pending 已失效（超时 /
    // 被 cancel / 换了 session），不静默按当前状态写入 —— 那会绕过确认闸门。
    // 明确提示重跑首次命令，让用户重新看一遍待保存内容。
    const key = pendingKeyFor(ctx, sel);
    const pending = getPending(key);
    if (!pending || pending.kind !== "config-lock") {
      const text =
        "ℹ️ 没有待确认的默认配置（可能已确认、已取消或已超过 5 分钟）。\n\n" +
        "请重新执行 `mem:config-lock` 查看待保存内容后再确认。";
      return result(ctx, requestId, false, text);
    }
    const d = pending.draft;
    clearPending(key);
    return applyLock(ctx, requestId, { teamId: d.teamId, agentId: d.agentId, taskId: d.taskId }, {
      ...sel,
      teamId: d.teamId,
      agentId: d.agentId,
      taskId: d.taskId,
      teamName: d.teamName,
      agentName: d.agentName,
      taskName: d.taskName,
      isVirtualDefault: d.isVirtualDefault,
    });
  }

  // ── 首次调用：判断是否需要二次确认 ───────────────────────────────────────
  //
  // 只有"已存在旧配置且与本次不同"才进 pending 等确认；无旧配置或完全相同
  // 直接落库（见文件头注释的决策依据）。
  let previous: PendingConfigLockDraft["previous"] = null;
  try {
    const client = makeClient(ctx);
    const existing = await client.getUserSessionDefault(ctx.userId);
    if (existing) {
      previous = {
        teamId: existing.team_id,
        agentId: existing.agent_id,
        taskId: existing.task_id,
      };
    }
  } catch (err) {
    // 读旧配置失败不阻断命令：退化成"当作没有旧配置 → 一步落库"。
    // 这里不把错误抛给用户 —— 落库本身有 Core 的完整校验兜底，而"读到旧值"
    // 只是为了决定要不要多问一句，失败不该影响主流程。
    console.warn(
      `[mem-command:config-lock] getUserSessionDefault failed for user=${ctx.userId}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  const isSame =
    !!previous &&
    previous.teamId === sel.teamId &&
    previous.agentId === sel.agentId &&
    previous.taskId === sel.taskId;

  if (previous && !isSame) {
    const draft: PendingConfigLockDraft = {
      teamId: sel.teamId,
      agentId: sel.agentId,
      taskId: sel.taskId,
      teamName: sel.teamName,
      agentName: sel.agentName,
      taskName: sel.taskName,
      isVirtualDefault: sel.isVirtualDefault,
      previous,
    };
    setPending(pendingKeyFor(ctx, sel), { kind: "config-lock", draft });
    console.log(
      `[mem-command:config-lock] pending confirm user=${ctx.userId} session=${ctx.sessionKey} ` +
        `new=(${sel.teamId},${sel.agentId},${sel.taskId}) ` +
        `old=(${previous.teamId},${previous.agentId},${previous.taskId})`,
    );
    return result(ctx, requestId, true, formatPendingPreview(draft), {
      pending_confirm: true,
      team_id: sel.teamId,
      agent_id: sel.agentId,
      task_id: sel.taskId,
    });
  }

  // 无旧配置 / 与旧配置完全相同 → 一步落库（PRD "已有配置时直接覆盖" 的同值情形）
  return applyLock(ctx, requestId, { teamId: sel.teamId, agentId: sel.agentId, taskId: sel.taskId }, sel);
}
