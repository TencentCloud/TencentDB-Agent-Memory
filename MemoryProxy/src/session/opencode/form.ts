/**
 * opencode Session Init Form — `question` tool_call 载体。
 *
 * opencode CLI（sst/opencode，Bun 打包二进制）在 agent-loop 里维护一个**硬白名单**
 * tools 集合：`bash, edit, glob, grep, invalid, question, read, skill, task,
 * todowrite, webfetch, write`。任何名字不在白名单里的 tool_call 都会被客户端
 * 拒绝并渲染成 `invalid [tool=xxx, error=Model tried to call unavailable tool]`。
 *
 * 因此 proxy 侧的 session-init form **不能沿用** CB 的 `ask_followup_question`
 * 或 CC 的 `AskUserQuestion`——必须映射到 opencode 原生 `question` 工具。
 *
 * # `question` 工具的 schema 依据
 *
 * 来源：sst/opencode `packages/opencode/src/tool/question.ts` + Question v1
 * schema（`Question.Prompt`）。核心结构：
 *   {
 *     questions: [
 *       {
 *         question: string,             // 题干（必填）
 *         header:   string,             // ≤30 字符标题（必填）
 *         options:  [{label, description?}, ...],  // 至少 1 项
 *         multiple?: boolean,           // 是否多选（可选，默认 false）
 *       },
 *       ...
 *     ]
 *   }
 *
 * # 与 workbuddy form 的差异（3 处 + tool name）
 *   - tool_name: `AskUserQuestion` → `question`
 *   - multiSelect (camelCase) → **multiple**（opencode 独有命名，既不是 CC 的
 *     `multiSelect` 也不是 dsh 的 `multi_select`）
 *   - header 长度约束：opencode ≤30 字符（wb/CC 无限制）→ 用 `.slice(0, 30)`
 *   - tool_call id 前缀：`call_oc_session_init_`
 *
 * # 传输
 *   - 协议 = **OpenAI /v1/chat/completions**（opencode 底层用
 *     `@ai-sdk/openai-compatible` provider）
 *   - SSE stream 或 non-stream（与请求 `body.stream` 保持一致）
 *   - 骨架完全照抄 workbuddy（chunk 1 = role+tool_call decl / chunk 2 =
 *     arguments delta / chunk 3 = finish_reason:tool_calls / DONE）
 *
 * # 状态机
 *   - 完全复用 CB 状态机（session/codebuddy/init.ts），同 workbuddy/dsh 模式；
 *     stage 值（asset_confirm / team / agent_select / task_select / agent_task）
 *     与 CB 完全一致，直接透传。
 *
 * # 分页
 *   - opencode `question.options` 未见硬上限，但为了 UI 观感与 CC/WB 保持一致，
 *     沿用 `computePagination` + `MORE_LABEL` 尾槽方案（≤4 option/页）。
 *
 * # 用户答复的回传格式（供 extractor 参考）
 *   opencode `question` 工具在用户选完后，会给 model 回一段文本形式的 tool-result：
 *     `User has answered your questions: "问题1"="答案1", "问题2"="答案2, 答案3"`
 *   现有 extractor 的 substring fallback（按 team_name / agent_name / 后 8 位 id
 *   做 `hay.includes`）能覆盖这个格式，无需另加 opencode 专用分支。
 */

import type { TeamOption } from "../types.js";
import { computePagination, CC_MAX_OPTIONS as CC_MAX_OPTIONS_SHARED } from "../claude-code/pagination.js";

// ── Constants ──────────────────────────────────────────────────────────────────

/** opencode 原生 tool 名，硬白名单成员。不要改成 `AskUserQuestion` 或 `ask_followup_question`。 */
export const TOOL_NAME = "question";
export const TOOLCALL_PREFIX = "call_oc_session_init_";

export const TEAM_FORM_TITLE = "会话初始化 — 选择 Team";
export const AGENT_TASK_FORM_TITLE = "会话初始化 — 选择 Agent 与任务";
export const RETRY_FORM_TITLE = "未能识别选择，请重新选择";

export const SKIP_LABEL = "本次不关联（跳过注入，直接放行）";
export const MORE_LABEL = "更多 →";

export const ASSET_CONFIRM_YES = "是，关联团队资产";
export const ASSET_CONFIRM_NO = "否，本次不关联";
export const ASSET_CONFIRM_FORM_TITLE = "会话初始化 — 是否关联团队资产";

/**
 * 附在每步 question 文末的通用备注：告诉用户"选择跳过 = 本次 session init 跳过、
 * 不注入任何团队资产"。opencode `question` 工具的 UI 也支持用户自由输入答复
 * （非选项文字），回复"跳过 / skip / 不关联"会走 SKIP_RE bypass。
 * 文案与 claude-code / workbuddy / codex / codebuddy / dsh 六端统一。
 */
const SKIP_HINT = '（如选择"跳过"选项，本次 session init 将跳过，不注入任何团队资产）';

/** opencode question header 硬上限。schema 校验 ≤30 字符，超长会被客户端拒收。 */
const OC_HEADER_MAX = 30;

const CC_MAX_OPTIONS = CC_MAX_OPTIONS_SHARED;

/** 把任意 header 文本裁到 opencode schema 允许的 ≤30 字符。 */
function clipHeader(s: string): string {
  return s.length > OC_HEADER_MAX ? s.slice(0, OC_HEADER_MAX) : s;
}

/** Returns true if the given string contains any opencode form title marker. */
export function containsFormTitle(s: string): boolean {
  return (
    s.includes(TEAM_FORM_TITLE) ||
    s.includes(AGENT_TASK_FORM_TITLE) ||
    s.includes(RETRY_FORM_TITLE) ||
    s.includes(ASSET_CONFIRM_FORM_TITLE)
  );
}

/** Returns true if a tool_call id belongs to an opencode session-init form. */
export function isSessionInitToolCallId(id: string): boolean {
  return id.startsWith(TOOLCALL_PREFIX);
}

// ── Form Data ──────────────────────────────────────────────────────────────────

export type FormStage = "asset_confirm" | "team" | "agent_select" | "agent_task" | "task_select";

export interface FormData {
  teams: TeamOption[];
  stage: FormStage;
  selectedTeamId?: string;
  selectedAgentId?: string;
  /** 分页：当前页码 (0-based)；对齐 CC/WB 只使用一个 pageIndex（team/agent/task 单题） */
  pageIndex?: number;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
}

// ── opencode `question` input schema ───────────────────────────────────────────

interface OCQuestionOption {
  label: string;
  description: string;
}

interface OCAskQuestion {
  question: string;
  /** opencode 硬约束：≤30 字符。 */
  header: string;
  options: OCQuestionOption[];
  /** opencode 独有命名：`multiple`（既不是 CC 的 `multiSelect` 也不是 dsh 的 `multi_select`）。 */
  multiple: boolean;
}

function buildQuestionArgs(data: FormData): { questions: OCAskQuestion[] } {
  const { teams, stage, selectedTeamId, retry } = data;
  const titlePrefix = retry ? "⚠️ " : "";
  const questions: OCAskQuestion[] = [];

  if (stage === "asset_confirm") {
    questions.push({
      question: titlePrefix + "本次对话是否要关联团队资产？" + SKIP_HINT,
      header: clipHeader("关联资产"),
      options: [
        { label: ASSET_CONFIRM_YES, description: "选择 Team / Agent / Task，注入团队上下文" },
        { label: ASSET_CONFIRM_NO, description: "本次不注入任何内容，直接放行" },
      ],
      multiple: false,
    });
    return { questions };
  }

  if (stage === "team") {
    const teamOpts = teams.slice(0, CC_MAX_OPTIONS).map((t) => ({
      label: `${t.team_name} (${t.team_id.slice(-8)})`,
      description: "",
    }));
    if (teamOpts.length < 2) {
      throw new Error(
        `[oc form] team stage requires ≥2 teams (got ${teamOpts.length}). ` +
          `Caller must auto-select when teams.length === 1.`,
      );
    }
    questions.push({
      question: titlePrefix + "请选择本次会话所属的 Team：" + SKIP_HINT,
      header: clipHeader("Team"),
      options: teamOpts.slice(0, CC_MAX_OPTIONS),
      multiple: false,
    });
    return { questions };
  }

  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { questions };

  if (stage === "agent_select" || stage === "agent_task") {
    const pageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(team.agents.length, pageIndex);
    const slice = team.agents.slice(page.start, page.end);

    const combinedOptions: OCQuestionOption[] = slice.map((a) => ({
      label: `${a.agent_name} (${a.agent_id.slice(-8)})`,
      description: a.description ?? "",
    }));

    if (!page.isLastPage) {
      const remaining = page.total - page.end;
      combinedOptions.push({ label: MORE_LABEL, description: `查看下一批（还剩 ${remaining} 个 Agent）` });
    }

    if (combinedOptions.length < 2) {
      throw new Error(
        `[oc form] agent page ${pageIndex} has ${combinedOptions.length} option(s); ` +
          `pagination.ts should have avoided a solo last page.`,
      );
    }

    const pageSuffix = page.totalPages > 1 ? `（第 ${pageIndex + 1}/${page.totalPages} 页）` : "";
    questions.push({
      question: titlePrefix + `请选择「${team.team_name}」下要使用的 Agent${pageSuffix}：` + SKIP_HINT,
      header: clipHeader(page.totalPages > 1 ? `Agent ${pageIndex + 1}/${page.totalPages}` : "Agent"),
      options: combinedOptions.slice(0, CC_MAX_OPTIONS),
      multiple: false,
    });
    return { questions };
  }

  if (stage === "task_select") {
    const taskPageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(team.tasks.length, taskPageIndex);
    const taskSlice = team.tasks.slice(page.start, page.end);

    const taskOpts: OCQuestionOption[] = taskSlice.map((t) => ({
      label: t.isDefault
        ? t.task_name
        : `${t.task_name} (${t.task_id.slice(-8)})`,
      description: "",
    }));

    if (!page.isLastPage) {
      const remaining = page.total - page.end;
      taskOpts.push({
        label: MORE_LABEL,
        description: `查看下一批（还剩 ${remaining} 个任务）`,
      });
    }

    if (taskOpts.length < 2) {
      throw new Error(
        `[oc form] task page ${taskPageIndex} has ${taskOpts.length} option(s); ` +
          `pagination.ts should have avoided a solo last page.`,
      );
    }

    const taskPageSuffix = page.totalPages > 1 ? `（第 ${taskPageIndex + 1}/${page.totalPages} 页）` : "";
    questions.push({
      question: titlePrefix + `请选择「${team.team_name}」下要关联的任务${taskPageSuffix}：` + SKIP_HINT,
      header: clipHeader(page.totalPages > 1 ? `Task ${taskPageIndex + 1}/${page.totalPages}` : "Task"),
      options: taskOpts.slice(0, CC_MAX_OPTIONS),
      multiple: false,
    });
    return { questions };
  }

  return { questions };
}

// ── Form Builder ───────────────────────────────────────────────────────────────

/**
 * Build an opencode `question` fake form response.
 *
 * 传输：**OpenAI chat/completions**（stream 或 non-stream）。
 * arguments shape：opencode 原生 `{questions: [{question, header, options, multiple}]}`。
 */
export function buildFormResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const created = Math.floor(Date.now() / 1000);
  const id = "oc-session-init-" + Date.now();
  const toolCallId = TOOLCALL_PREFIX + Date.now();
  const input = buildQuestionArgs(data);
  const argsStr = JSON.stringify(input);

  if (data.stream) {
    return buildOpenAIStreamingResponse(id, created, model, toolCallId, argsStr);
  }
  return buildOpenAINonStreamingResponse(id, created, model, toolCallId, argsStr);
}

// ── OpenAI Non-streaming ───────────────────────────────────────────────────────

function buildOpenAINonStreamingResponse(
  id: string,
  created: number,
  model: string,
  toolCallId: string,
  argsStr: string,
): Response {
  return new Response(JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: toolCallId,
          type: "function",
          function: {
            name: TOOL_NAME,
            arguments: argsStr,
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ── OpenAI Streaming ───────────────────────────────────────────────────────────

function buildOpenAIStreamingResponse(
  id: string,
  created: number,
  model: string,
  toolCallId: string,
  argsStr: string,
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Chunk 1: role + tool_call declaration (empty arguments)
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            tool_calls: [{
              index: 0,
              id: toolCallId,
              type: "function",
              function: { name: TOOL_NAME, arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`));

      // Chunk 2: arguments delta (whole JSON as single delta)
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: argsStr },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`));

      // Chunk 3: finish
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })}\n\n`));

      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
}
