/**
 * Hermes Session Init Form — 载体是 hermes 原生 `clarify` 工具。
 *
 * # schema 依据（本机 hermes-agent 0.19.0 源码实证，不是推测）
 *
 *   tools/clarify_tool.py::CLARIFY_SCHEMA.parameters = {
 *     properties: {
 *       question: { type: "string" },
 *       choices:  { type: "array", items: { type: "string" }, maxItems: 4 },
 *     },
 *     required: ["question"],
 *   }
 *
 *   tools/clarify_tool.py::registry.register 的 handler：
 *     clarify_tool(question=args.get("question", ""), choices=args.get("choices"), ...)
 *
 * => fake tool_call 的 arguments 必须是**扁平**的 `{question, choices}`，且一次只问一题。
 *    发 `{questions:[{...}]}`（opencode `question` 工具的形态）会被 clarify_tool 判定为
 *    缺 question，直接返回 `{"error":"Question text is required."}` —— 用户看不到表单，
 *    而该 error 又会被当成 headless 信号静默 bypass。这条是 2026-09-10 联调实测踩到的坑。
 *
 * # 与其它客户端 form 的关系
 *   - 状态机：完全复用 CB 状态机（session/codebuddy/init.ts），stage 值与 CB 一致；
 *   - 传输：OpenAI /v1/chat/completions（stream / non-stream 跟随请求），
 *     3-chunk SSE 骨架与 opencode / dsh 保持一致；
 *   - 差异只在 tool 名（`clarify`）、参数形状（扁平单题）、tool_call id 前缀。
 *
 * # 选项数量
 *   hermes clarify 硬上限 4 项（MAX_CHOICES=4），与 CC 的 AskUserQuestion 相同，
 *   因此沿用共享的 computePagination（非末页 3 项 + "更多" 尾槽，末页 2~4 项）。
 *   UI 会自动追加 "Other (type your answer)"，所以用户始终可以手输答案。
 */

import type { TeamOption } from "../types.js";
import { computePagination, CC_MAX_OPTIONS } from "../claude-code/pagination.js";

// ── Constants ──────────────────────────────────────────────────────────────────

/** hermes 原生工具名，不要改成 AskUserQuestion / ask_followup_question / question。 */
export const TOOL_NAME = "clarify";
export const TOOLCALL_PREFIX = "call_hermes_session_init_";

/** 与 hermes `tools/clarify_tool.py::MAX_CHOICES` 保持一致。 */
export const HERMES_MAX_CHOICES = 4;

export const TEAM_FORM_TITLE = "会话初始化 — 选择 Team";
export const AGENT_TASK_FORM_TITLE = "会话初始化 — 选择 Agent 与任务";
export const RETRY_FORM_TITLE = "未能识别选择，请重新选择";

export const SKIP_LABEL = "本次不关联（跳过注入，直接放行）";
export const MORE_LABEL = "更多 →";

export const ASSET_CONFIRM_YES = "是，关联团队资产";
export const ASSET_CONFIRM_NO = "否，本次不关联";
export const ASSET_CONFIRM_FORM_TITLE = "会话初始化 — 是否关联团队资产";

/**
 * 每步 question 文末的备注。hermes 的 clarify UI 支持"其他（自己输入）"，所以
 * 用户输入"跳过 / skip / 不关联"也会被 SKIP_RE 捕获走 bypass。
 * 文案与 opencode / dsh / workbuddy 保持一致。
 */
const SKIP_HINT = '（请选择最匹配的选项；若选择跳过，本次 Session 将不注入团队资产）';

/** 标题前缀：重试时加警示符，和 CC/WB/dsh/opencode 一致。 */
function titlePrefix(retry?: boolean): string {
  return retry ? "⚠️ " : "";
}

/** 把列表项渲染成 hermes 选项文本：`名字 (id 后 8 位)`。 */
function optionLabel(name: string, id: string): string {
  return `${name} (${id.slice(-8)})`;
}

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
  /** 当前页码（0-based）；team / agent / task 单题复用一个 pageIndex。 */
  pageIndex?: number;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
}

// ── clarify arguments（扁平单题，见文件头 schema 依据）──────────────────────────

export interface HermesClarifyArgs {
  question: string;
  /**
   * 选项列表，1~4 项。省略表示开放式提问（hermes 渲染成自由输入）。
   * 不传空数组：hermes 会把空数组规整回"开放式"，语义容易混淆。
   */
  choices?: string[];
}

/** 分页渲染一页选项：末页以外补 "更多 →" 尾槽，整体裁到 4 项上限。 */
function pageChoices(
  labels: string[],
  page: { start: number; end: number; isLastPage: boolean; total: number },
  kindLabel: string,
): string[] {
  const slice = labels.slice(page.start, page.end);
  if (!page.isLastPage) {
    const remaining = page.total - page.end;
    slice.push(`${MORE_LABEL}（还剩 ${remaining} 个 ${kindLabel}）`);
  }
  return slice.slice(0, HERMES_MAX_CHOICES);
}

/**
 * 构造本轮的 clarify arguments。
 *
 * 设计约束（与参考实现的关键差异）：
 *   1. 必须是扁平 `{question, choices}`，不是 `{questions:[...]}`；
 *   2. 不抛异常 —— 这里在响应构造路径上，抛错会把正常请求变成 500。
 *      选项为 0 时退化成开放式提问（让用户手输），选项为 1 时照常单选项提问；
 *   3. 每次只问一题 —— CB 状态机本身就是逐 stage 推进的，天然匹配。
 */
export function buildClarifyArgs(data: FormData): HermesClarifyArgs {
  const { teams, stage, selectedTeamId, retry } = data;
  const prefix = titlePrefix(retry);
  const pageIndex = Math.max(0, data.pageIndex ?? 0);

  if (stage === "asset_confirm") {
    return {
      question: prefix + "本次对话是否要关联团队资产？" + SKIP_HINT,
      choices: [ASSET_CONFIRM_YES, ASSET_CONFIRM_NO],
    };
  }

  if (stage === "team") {
    const page = computePagination(teams.length, pageIndex);
    const choices = pageChoices(
      teams.map((t) => optionLabel(t.team_name, t.team_id)),
      page,
      "Team",
    );
    const pageSuffix = page.totalPages > 1 ? `（第 ${pageIndex + 1}/${page.totalPages} 页）` : "";
    const question = prefix + `请选择本次会话所属的 Team${pageSuffix}：` + SKIP_HINT;
    return choices.length > 0 ? { question, choices } : { question };
  }

  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { question: prefix + "未找到可选团队，请稍后重试。" };

  if (stage === "agent_select" || stage === "agent_task") {
    const page = computePagination(team.agents.length, pageIndex);
    const choices = pageChoices(
      team.agents.map((a) => optionLabel(a.agent_name, a.agent_id)),
      page,
      "Agent",
    );
    const pageSuffix = page.totalPages > 1 ? `（第 ${pageIndex + 1}/${page.totalPages} 页）` : "";
    const question = prefix + `请选择「${team.team_name}」下要使用的 Agent${pageSuffix}：` + SKIP_HINT;
    return choices.length > 0 ? { question, choices } : { question };
  }

  if (stage === "task_select") {
    const page = computePagination(team.tasks.length, pageIndex);
    const choices = pageChoices(
      team.tasks.map((t) => (t.isDefault ? t.task_name : optionLabel(t.task_name, t.task_id))),
      page,
      "任务",
    );
    const pageSuffix = page.totalPages > 1 ? `（第 ${pageIndex + 1}/${page.totalPages} 页）` : "";
    const question = prefix + `请选择「${team.team_name}」下要关联的任务${pageSuffix}：` + SKIP_HINT;
    return choices.length > 0 ? { question, choices } : { question };
  }

  return { question: prefix + "会话初始化：请按提示选择。" };
}

// ── Form Builder ───────────────────────────────────────────────────────────────

/**
 * 构造 hermes clarify 的假表单响应。
 * 传输协议 = OpenAI chat/completions；stream 跟随原请求。
 */
export function buildFormResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const created = Math.floor(Date.now() / 1000);
  const id = "hermes-session-init-" + Date.now();
  const toolCallId = TOOLCALL_PREFIX + Date.now();
  const argsStr = JSON.stringify(buildClarifyArgs(data));

  return data.stream
    ? buildOpenAIStreamingResponse(id, created, model, toolCallId, argsStr)
    : buildOpenAINonStreamingResponse(id, created, model, toolCallId, argsStr);
}

function buildOpenAINonStreamingResponse(
  id: string,
  created: number,
  model: string,
  toolCallId: string,
  argsStr: string,
): Response {
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
            content: null,
            tool_calls: [
              {
                id: toolCallId,
                type: "function",
                function: { name: TOOL_NAME, arguments: argsStr },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

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
      // Chunk 1: role + tool_call 声明（arguments 为空）
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
                delta: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      index: 0,
                      id: toolCallId,
                      type: "function",
                      function: { name: TOOL_NAME, arguments: "" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        ),
      );

      // Chunk 2: arguments 全量 delta（与 opencode/dsh 保持一致的单块下发）
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
                delta: { tool_calls: [{ index: 0, function: { arguments: argsStr } }] },
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
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
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
      "Connection": "keep-alive",
    },
  });
}

/** 仅供测试/调试：暴露分页槽位上限，确保与分页实现同源。 */
export const PAGINATION_SLOT_LIMIT = CC_MAX_OPTIONS;
