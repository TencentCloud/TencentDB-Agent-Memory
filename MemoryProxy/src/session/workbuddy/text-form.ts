/**
 * text-form.ts — WorkBuddy 无 AskUserQuestion 工具时的文字模式渲染层.
 *
 * 场景：新版 WorkBuddy 官方 tools 集合里拿掉了 AskUserQuestion（能力探测已判定
 * `capabilities.askUserQuestion === false`），继续发 tool_calls SSE 客户端会收下
 * 但不知道怎么渲染 → 卡死。降级为：走 OpenAI chat.completions 的 **content chunk**
 * 流，把选项渲染成 markdown 让 LLM 客户端原样透传给用户看。
 *
 * 排版原则：
 *   - **不用 emoji**（用户 rule）
 *   - 用 `====` 主标题分隔线、`----` 提示区分隔线、编号右对齐、空行分块
 *   - 视觉层次靠纯 ASCII，不依赖 markdown 渲染
 *
 * 分页：使用独立的 `computeTextPagination`（每页 10 项，无 MORE 槽位）。
 * 用户翻页靠 `next / prev` 关键字，在 CP3 解析层识别（本文件只负责渲染）。
 *
 * 传输：
 *   - stream=true  → SSE, 一次 role chunk + 一次 content chunk + finish + [DONE]
 *   - stream=false → OpenAI chat.completion JSON, choices[0].message.content = markdown
 */

import type { TeamOption, AgentInTeam, TaskInTeam } from "../types.js";
import type { FormData, FormStage } from "./form.js";
import { computeTextPagination, TEXT_PAGE_SIZE } from "./text-pagination.js";

// ── Constants ──────────────────────────────────────────────────────────────────

/** 主标题分隔线（视觉上等价于卡片模式的标题 emoji）。 */
const RULE_MAJOR = "================================================";
/** 提示区分隔线（视觉上分隔选项列表和操作提示）。 */
const RULE_MINOR = "------------------------------------------------";

/** 4 个 stage 的标题（不含步骤号，步骤号动态拼）。 */
const STAGE_TITLES: Record<FormStage, string> = {
  asset_confirm: "是否关联团队资产？",
  team: "选择 Team",
  agent_select: "选择 Agent",
  task_select: "选择 Task",
  agent_task: "选择 Agent 与 Task", // legacy, 文字模式不常用（WB 走 CC 拆分路径）
};

/** 4 个 stage 的步骤号（用于"步骤 N/4"提示）。 */
const STAGE_STEP: Record<FormStage, number> = {
  asset_confirm: 1,
  team: 2,
  agent_select: 3,
  task_select: 4,
  agent_task: 3, // legacy
};

/** 每个 session-init 流程的总步骤数（用于"步骤 N/4"提示）。 */
const TOTAL_STEPS = 4;

// asset_confirm 的两个选项 label —— 必须跟 workbuddy/form.ts 的 ASSET_CONFIRM_YES/NO
// 一致：CP3 解析层要把用户回复归一化成这两个字符串，注入 fake tool_result 后
// CB extractor 才能识别。这里没 import 而是 re-declare，让 text-form 保持独立
// 可测；如果 form.ts 那边改常量，测试会双写失败提醒同步。
export const TEXT_ASSET_CONFIRM_YES_LABEL = "是，关联团队资产";
export const TEXT_ASSET_CONFIRM_NO_LABEL = "否，本次不关联";

/**
 * 文字模式 content 里首行标记，用于回显时识别（未来若 injector 层想剔除自己
 * 上一轮发的初始化文本，可以通过这个前缀识别）。
 */
export const TEXT_FORM_MARKER = "[会话初始化]";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RetryContext {
  /** 用户上一轮的原始回复（用于回显 "未能识别你的回复 xxx"）。 */
  userReplyPreview?: string;
  /** 已尝试次数（1-based，用于"第 N 次尝试"提示）。 */
  attemptCount?: number;
  /** 剩余尝试次数（用于"再 M 次未识别将自动跳过"提示）。 */
  attemptsLeft?: number;
}

// ── Renderers per stage ────────────────────────────────────────────────────────

/**
 * 渲染 asset_confirm 阶段的 markdown 文本。
 */
export function renderAssetConfirmText(retry?: RetryContext): string {
  const header = renderHeader("asset_confirm", null, retry);
  const body = [
    "",
    "   1.  是，关联团队资产",
    "   2.  否，本次不关联",
    "",
    RULE_MINOR,
    "  回复方式：请输入 yes 或 no",
    "",
  ].join("\n");
  return header + body;
}

/**
 * 渲染 team 阶段的 markdown 文本。
 */
export function renderTeamText(teams: readonly TeamOption[], pageIndex: number, retry?: RetryContext): string {
  const p = computeTextPagination(teams, pageIndex);
  const header = renderHeader("team", p, retry);
  const body = renderOptionList(p.currentPageItems, p.offset, (t) => ({
    primary: t.team_name ?? t.team_id,
    secondary: t.team_id,
  }));
  const footer = renderFooter(p, "team", teams.length);
  return header + "\n" + body + "\n" + footer;
}

/**
 * 渲染 agent_select 阶段的 markdown 文本。
 *
 * @param teams          全量 teams（用于从 selectedTeamId 取 agents）
 * @param selectedTeamId 已选 team 的 id
 * @param pageIndex      当前页码
 * @param retry          可选，retry 上下文
 */
export function renderAgentText(
  teams: readonly TeamOption[],
  selectedTeamId: string | undefined,
  pageIndex: number,
  retry?: RetryContext,
): string {
  const team = findTeam(teams, selectedTeamId);
  const agents: readonly AgentInTeam[] = team?.agents ?? [];
  const p = computeTextPagination(agents, pageIndex);
  const header = renderHeader("agent_select", p, retry);
  const body = renderOptionList(p.currentPageItems, p.offset, (a) => ({
    primary: a.agent_name ?? a.agent_id,
    secondary: a.agent_id,
    tertiary: a.description,
  }));
  const footer = renderFooter(p, "agent", agents.length);
  return header + "\n" + body + "\n" + footer;
}

/**
 * 渲染 task_select 阶段的 markdown 文本。
 */
export function renderTaskText(
  teams: readonly TeamOption[],
  selectedTeamId: string | undefined,
  pageIndex: number,
  retry?: RetryContext,
): string {
  const team = findTeam(teams, selectedTeamId);
  const tasks: readonly TaskInTeam[] = team?.tasks ?? [];
  const p = computeTextPagination(tasks, pageIndex);
  const header = renderHeader("task_select", p, retry);
  const body = renderOptionList(p.currentPageItems, p.offset, (t) => ({
    primary: t.task_name ?? t.task_id,
    secondary: t.task_id || "(无 task-id)",
    tertiary: t.isDefault ? "默认任务" : undefined,
  }));
  const footer = renderFooter(p, "task", tasks.length);
  return header + "\n" + body + "\n" + footer;
}

// ── Bypass notice ──────────────────────────────────────────────────────────────

/**
 * 3 次连续无法识别后的兜底提示文案（CP4 会调用）。
 */
export function renderBypassNotice(): string {
  return [
    RULE_MAJOR,
    `  ${TEXT_FORM_MARKER} 已跳过团队资产关联`,
    RULE_MAJOR,
    "",
    "  尝试 3 次仍未识别选择，本次会话将不关联团队资产，",
    "  直接放行后续对话。",
    "",
    "  如需重新初始化，请发送 `mem:session-reset`。",
    "",
  ].join("\n");
}

// ── Main dispatcher ────────────────────────────────────────────────────────────

export interface BuildTextFormOptions {
  /** retry 上下文（可选），非 retry 情况下传 undefined。 */
  retry?: RetryContext;
}

/**
 * 根据 formData.stage 分派到对应渲染函数，输出完整 markdown 字符串。
 */
export function renderTextForm(data: FormData, options: BuildTextFormOptions = {}): string {
  const retry = options.retry;
  const pageIndex = data.pageIndex ?? 0;

  switch (data.stage) {
    case "asset_confirm":
      return renderAssetConfirmText(retry);
    case "team":
      return renderTeamText(data.teams, pageIndex, retry);
    case "agent_select":
    case "agent_task": // legacy: 也当 agent 渲染
      return renderAgentText(data.teams, data.selectedTeamId, pageIndex, retry);
    case "task_select":
      return renderTaskText(data.teams, data.selectedTeamId, pageIndex, retry);
    default:
      // Unreachable in practice, but keep a graceful fallback.
      return renderBypassNotice();
  }
}

/**
 * 构造完整的 HTTP Response（stream 或 non-stream），把 renderTextForm 的 markdown
 * 塞到 OpenAI chat.completions 的 content 字段里。
 */
export function buildWorkBuddyTextFormResponse(
  data: FormData,
  options: BuildTextFormOptions = {},
): Response {
  const markdown = renderTextForm(data, options);
  return buildTextContentResponse(markdown, data.modelId, data.stream === true);
}

/**
 * 构造 bypass 场景的 Response（3 次 retry 后的兜底文案，CP4 会用）。
 */
export function buildBypassNoticeResponse(modelId?: string, stream = false): Response {
  return buildTextContentResponse(renderBypassNotice(), modelId, stream);
}

// ── HTTP Response Builders ─────────────────────────────────────────────────────

function buildTextContentResponse(content: string, modelId?: string, stream = false): Response {
  const model = modelId ?? "unknown";
  const created = Math.floor(Date.now() / 1000);
  const id = "wb-session-init-text-" + Date.now();

  if (stream) {
    return buildStreamingContent(id, created, model, content);
  }
  return buildNonStreamingContent(id, created, model, content);
}

function buildNonStreamingContent(id: string, created: number, model: string, content: string): Response {
  return new Response(
    JSON.stringify({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function buildStreamingContent(id: string, created: number, model: string, content: string): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Chunk 1: role
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "" },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        ),
      );

      // Chunk 2: content（整体一次性发出；不必按 token 拆分，客户端只需要能读到完整文本）
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: { content },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        ),
      );

      // Chunk 3: finish
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          })}\n\n`,
        ),
      );

      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ── Internal helpers ───────────────────────────────────────────────────────────

interface OptionLine {
  primary: string;
  secondary?: string;
  tertiary?: string;
}

/**
 * 渲染标题区块（含分隔线 + 步骤号 + 副标题分页信息 / retry 信息）。
 */
function renderHeader(stage: FormStage, pagination: ReturnType<typeof computeTextPagination> | null, retry?: RetryContext): string {
  const step = STAGE_STEP[stage];
  const title = STAGE_TITLES[stage];
  const isRetry = retry !== undefined;

  const lines: string[] = [];
  lines.push(RULE_MAJOR);

  if (isRetry) {
    // Retry 标题：突出"未能识别"
    const preview = truncatePreview(retry?.userReplyPreview);
    lines.push(`  ${TEXT_FORM_MARKER} 未能识别你的回复${preview ? ` "${preview}"` : ""}`);
    if (typeof retry?.attemptCount === "number") {
      const left = retry.attemptsLeft;
      const leftPart = typeof left === "number" && left > 0
        ? `，再 ${left} 次未识别将自动跳过`
        : "";
      lines.push(`  第 ${retry.attemptCount} 次尝试${leftPart}`);
    }
    lines.push(RULE_MAJOR);
    lines.push("");
    lines.push(`  ${TEXT_FORM_MARKER} 步骤 ${step}/${TOTAL_STEPS}：${title}`);
    if (pagination && !pagination.isEmpty) {
      lines.push(`  第 ${pagination.currentPageIndex + 1} 页 / 共 ${pagination.totalPages} 页`);
    }
  } else {
    lines.push(`  ${TEXT_FORM_MARKER} 步骤 ${step}/${TOTAL_STEPS}：${title}`);
    if (pagination && !pagination.isEmpty) {
      lines.push(`  第 ${pagination.currentPageIndex + 1} 页 / 共 ${pagination.totalPages} 页`);
    }
    lines.push(RULE_MAJOR);
  }

  return lines.join("\n");
}

/**
 * 渲染选项列表。编号右对齐（1..99 都能对齐）。
 *
 * ⚠️ 显式包一层 ```plaintext code fence：
 *   我们的选项行本身用 "  N.  xxx" 前缀（缩进 3~4 空格）—— 落到 markdown
 *   renderer 眼里，1~9 行是 4 空格缩进（触发 indented-code-block），10+ 行
 *   缩进减少一位掉出 code block；且 tertiary（description）副行也是不同缩进。
 *   结果是 workbuddy 客户端把 1~9 项包在 code chip 里、10+ 项和描述行掉出来
 *   变成裸文本（图 1 现象）。主动包 ```plaintext fence 后，整段以 fenced
 *   code-block 语义渲染，行内空格数就完全无所谓了，视觉一致。
 */
function renderOptionList<T>(
  items: readonly T[],
  offset: number,
  extract: (item: T) => OptionLine,
): string {
  if (items.length === 0) {
    return "\n```plaintext\n  (当前列表为空)\n```\n";
  }

  const lines: string[] = ["", "```plaintext"];
  items.forEach((item, i) => {
    const absoluteIdx = offset + i + 1; // 1-based 显示序号
    const line = extract(item);
    const numStr = `${absoluteIdx}.`.padStart(4, " ");
    // 主行：编号 + 主标签 + ID（用 " · " 分隔）
    const idPart = line.secondary ? `  ·  ${line.secondary}` : "";
    lines.push(`  ${numStr}  ${line.primary}${idPart}`);
    // 副行：描述或标签（缩进对齐）
    if (line.tertiary) {
      lines.push(`         ${line.tertiary}`);
    }
  });
  lines.push("```", "");
  return lines.join("\n");
}

/**
 * 渲染操作提示区（回复方式说明 + next/prev/skip 关键字）。
 *
 * 数字寻址按**全表 1-based 序号**（跟 renderOptionList 的 absoluteIdx 一致），
 * 所以范围提示要用 `totalItems`（全表长度），不是 `currentPageItems.length`。
 * 例：task_select 共 28 项分 3 页，无论用户翻到哪页，回复提示都写 "1..28"。
 */
function renderFooter(
  pagination: ReturnType<typeof computeTextPagination>,
  _entity: "team" | "agent" | "task",
  totalItems: number,
): string {
  const lines: string[] = [];
  lines.push(RULE_MINOR);
  lines.push("  回复方式：");
  const pageRange = pagination.isEmpty
    ? "(空)"
    : `1..${totalItems}`;
  lines.push(`    - 数字（如 ${pagination.isEmpty ? "1" : "2"}，范围 ${pageRange}）`);
  if (pagination.hasNext) {
    lines.push("    - next / 下一页  —— 查看更多");
  }
  if (pagination.hasPrev) {
    lines.push("    - prev / 上一页  —— 返回上一页");
  }
  lines.push("    - skip / 跳过    —— 不关联团队资产");
  lines.push("");
  return lines.join("\n");
}

function findTeam(teams: readonly TeamOption[], selectedTeamId: string | undefined): TeamOption | undefined {
  if (!selectedTeamId) return teams[0];
  return teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
}

function truncatePreview(s?: string, max = 40): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + "...";
}

// ── Re-exports ─────────────────────────────────────────────────────────────────

export { TEXT_PAGE_SIZE };
