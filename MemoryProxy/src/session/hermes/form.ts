/**
 * Hermes Session Init Form — `clarify` tool_call 载体。
 *
 * hermes（github.com/NousResearch/hermes-agent）内置交互式提问工具 `clarify`
 * （tools/clarify_tool.py，CLARIFY_SCHEMA），在 CLI/gateway 默认工具集里
 * （toolsets.py `_HERMES_CORE_TOOLS`），是 hermes 原生的"AskUserQuestion 同族"
 * 交互载体：CLI 方向键面板、消息平台按钮/数字列表、gateway 阻塞式 Event 队列。
 *
 * proxy 侧的 session-init form 复用这个 hermes 原生 tool 名，fake 一个
 * assistant tool_call SSE 让 hermes 的 agent-loop 执行 clarify → 弹原生 UI →
 * 把用户回答以 role=tool JSON 结果回填（下一条请求），与 dsh/workbuddy 同模式。
 *
 * # 与 dsh form 的差异（2 处 shape 差异 + tool name）
 *   - tool_name: `ask_user_question` → `clarify`
 *   - arguments shape：clarify 是 `{questions: [{question, choices?, multi_select?}]}`，
 *     choices 是**平铺字符串数组**（≤4，hermes 端 `MAX_CHOICES=4` 硬截断），
 *     没有 dsh 的 `{label, description}` 对象、没有必填 id、没有 header 字段。
 *     dsh 用 "UI 无上限不分页"，clarify 必须**分页**（同 workbuddy/opencode，
 *     复用 claude-code/pagination.ts：非末页 3 项 + MORE，末页 ≤4）。
 *   - hermes UI 会自动追加 "Other (type your answer)" 自由文本行（clarify_tool.py
 *     文档约定），用户手打"跳过/skip/不关联"会走 SKIP_RE bypass —— 与
 *     opencode/dsh 的自由文本兜底语义一致。
 *
 * # 用户答复的回传格式（供 ../hermes/extractor.ts 参考）
 *   clarify 执行结果是一段 JSON 字符串，作为 role=tool 消息回填：
 *     单题：{"question":"...","choices_offered":[...],"user_response":"答案"}
 *     批量：{"responses":[{"question":"...","user_response":"..."},...]}
 *     multi_select 时 user_response 是 string[]。
 *   **choices_offered 会原样回显所有选项标签（含"更多 →"与 SKIP_HINT 里的
 *   "跳过"字样）——必须先解包取 user_response 再喂 CB extractor**，否则
 *   SKIP_RE / MORE 判定会被回显文本误触发。见 hermes/extractor.ts。
 *
 * # 传输
 *   - 协议 = **OpenAI /v1/chat/completions**（hermes 自定义 base_url 恒走
 *     OpenAI Chat Completions，agent/agent_init.py provider 判定链 + 实证）
 *   - SSE stream 或 non-stream（与请求 `body.stream` 保持一致）
 *   - 3-chunk 骨架照抄 opencode/dsh（chunk 1 = role+tool_call decl / chunk 2 =
 *     arguments delta / chunk 3 = finish_reason:tool_calls / DONE）。hermes 的
 *     流式解析容忍稀疏 delta、arguments 按 JSON 校验（_repair_tool_call_arguments），
 *     无 dsh 那种 reasoning_content 非空硬约束，故不带 REASONING 占位。
 *
 * # 状态机
 *   - 完全复用 CB 状态机（session/codebuddy/init.ts），同 workbuddy/dsh/opencode
 *     模式；stage 值（asset_confirm / team / agent_select / task_select / agent_task）
 *     与 CB 完全一致，直接透传。clarify 一次只能弹一个题（与 opencode `question`
 *     同限制），必须走拆分 stage（agent_select → task_select）。
 *
 * # tool_call id 前缀
 *   - `call_hermes_session_init_` —— 区分于 CB（`call_session_init_`）、
 *     workbuddy（`call_wb_session_init_`）、dsh（`call_dsh_session_init_`）、
 *     opencode（`call_oc_session_init_`）
 *
 * # hermes 侧 schema 依据
 *   - hermes-agent `tools/clarify_tool.py`（CLARIFY_SCHEMA + MAX_CHOICES=4 +
 *     mark_recommended/strip_recommended —— hermes UI 给首选项加 "(Recommended)"
 *     标签但答案回传前会 strip，选项标签精确匹配不受影响）
 *   - hermes-agent `toolsets.py`（`clarify` 在核心工具集；`hermes-api-server` /
 *     `hermes-acp` 两个发行版剔除 —— 该场景由 handler 的 hermes headless
 *     bypass 兜底，不弹表单）
 */

import type { TeamOption } from "../types.js";
import { computePagination, CC_MAX_OPTIONS as CC_MAX_OPTIONS_SHARED } from "../claude-code/pagination.js";

// ── Constants ──────────────────────────────────────────────────────────────────

/** hermes 原生 tool 名。不要改成 `AskUserQuestion` / `ask_followup_question`。 */
export const TOOL_NAME = "clarify";
export const TOOLCALL_PREFIX = "call_hermes_session_init_";

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
 * 不注入任何团队资产"。hermes clarify UI 自动带 "Other" 自由文本行，用户回复
 * "跳过 / skip / 不关联"会走 SKIP_RE bypass。文案与 claude-code / workbuddy /
 * codex / codebuddy / dsh / opencode 各端统一。
 */
const SKIP_HINT = '（如选择"跳过"选项，本次 session init 将跳过，不注入任何团队资产）';

const CC_MAX_OPTIONS = CC_MAX_OPTIONS_SHARED;

/** Returns true if the given string contains any hermes form title marker. */
export function containsFormTitle(s: string): boolean {
  return (
    s.includes(TEAM_FORM_TITLE) ||
    s.includes(AGENT_TASK_FORM_TITLE) ||
    s.includes(RETRY_FORM_TITLE) ||
    s.includes(ASSET_CONFIRM_FORM_TITLE)
  );
}

/** Returns true if a tool_call id belongs to a hermes session-init form. */
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
  /** 分页：当前页码 (0-based)；对齐 CC/WB/opencode 只使用一个 pageIndex。 */
  pageIndex?: number;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
}

// ── clarify input schema（hermes CLARIFY_SCHEMA 的 questions[] 形态）──────────

interface HermesClarifyQuestion {
  /** 题干（必填）。选项只放 choices，不写进题干（clarify schema 约定）。 */
  question: string;
  /** ≤4 个平铺字符串（hermes MAX_CHOICES=4 硬截断）；省略 = 开放式提问。 */
  choices: string[];
  /** 单选固定 false（session-init 场景无多选需求）。 */
  multi_select: boolean;
}

function buildClarifyArgs(data: FormData): { questions: HermesClarifyQuestion[] } {
  const { teams, stage, selectedTeamId, retry } = data;
  const titlePrefix = retry ? "⚠️ " : "";
  const questions: HermesClarifyQuestion[] = [];

  if (stage === "asset_confirm") {
    questions.push({
      question: titlePrefix + "本次对话是否要关联团队资产？" + SKIP_HINT,
      choices: [
        ASSET_CONFIRM_YES,
        ASSET_CONFIRM_NO,
      ],
      multi_select: false,
    });
    return { questions };
  }

  if (stage === "team") {
    const pageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(teams.length, pageIndex);
    const teamOpts = teams.slice(page.start, page.end).map((t) =>
      `${t.team_name} (${t.team_id.slice(-8)})`,
    );
    if (!page.isLastPage) {
      teamOpts.push(MORE_LABEL);
    }
    if (teamOpts.length < 2) {
      throw new Error(
        `[hermes form] team stage requires ≥2 teams (page ${pageIndex} has ` +
          `${teamOpts.length} option). Caller must auto-select when teams.length === 1.`,
      );
    }
    const pageSuffix = page.totalPages > 1 ? `（第 ${pageIndex + 1}/${page.totalPages} 页）` : "";
    questions.push({
      question: titlePrefix + `请选择本次会话所属的 Team${pageSuffix}：` + SKIP_HINT,
      choices: teamOpts,
      multi_select: false,
    });
    return { questions };
  }

  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { questions };

  if (stage === "agent_select" || stage === "agent_task") {
    const pageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(team.agents.length, pageIndex);
    const slice = team.agents.slice(page.start, page.end);

    const agentOpts: string[] = slice.map((a) =>
      `${a.agent_name} (${a.agent_id.slice(-8)})`,
    );
    if (!page.isLastPage) {
      agentOpts.push(MORE_LABEL);
    }

    if (agentOpts.length < 2) {
      throw new Error(
        `[hermes form] agent page ${pageIndex} has ${agentOpts.length} option(s); ` +
          `pagination.ts should have avoided a solo last page.`,
      );
    }

    const pageSuffix = page.totalPages > 1 ? `（第 ${pageIndex + 1}/${page.totalPages} 页）` : "";
    questions.push({
      question: titlePrefix + `请选择「${team.team_name}」下要使用的 Agent${pageSuffix}：` + SKIP_HINT,
      choices: agentOpts,
      multi_select: false,
    });
    return { questions };
  }

  if (stage === "task_select") {
    const taskPageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(team.tasks.length, taskPageIndex);
    const taskSlice = team.tasks.slice(page.start, page.end);

    // team.tasks[0] 是虚拟 default 任务("本次不关联任务")，fetchTeamsAndAgents
    // 头部 unshift 一次；分页切片不会像旧版每页重复出现在开头。
    const taskOpts: string[] = taskSlice.map((t) =>
      t.isDefault ? t.task_name : `${t.task_name} (${t.task_id.slice(-8)})`,
    );
    if (!page.isLastPage) {
      taskOpts.push(MORE_LABEL);
    }

    if (taskOpts.length < 2) {
      throw new Error(
        `[hermes form] task page ${taskPageIndex} has ${taskOpts.length} option(s); ` +
          `pagination.ts should have avoided a solo last page.`,
      );
    }

    const taskPageSuffix = page.totalPages > 1 ? `（第 ${taskPageIndex + 1}/${page.totalPages} 页）` : "";
    questions.push({
      question: titlePrefix + `请选择「${team.team_name}」下要关联的任务${taskPageSuffix}：` + SKIP_HINT,
      choices: taskOpts,
      multi_select: false,
    });
    return { questions };
  }

  return { questions };
}

// ── Form Builder ───────────────────────────────────────────────────────────────

/**
 * Build a hermes `clarify` fake form response.
 *
 * 传输：**OpenAI chat/completions**（stream 或 non-stream）。
 * arguments shape：hermes 原生 `{questions: [{question, choices, multi_select}]}`。
 */
export function buildFormResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const created = Math.floor(Date.now() / 1000);
  const id = "hermes-session-init-" + Date.now();
  const toolCallId = TOOLCALL_PREFIX + Date.now();
  const input = buildClarifyArgs(data);
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
