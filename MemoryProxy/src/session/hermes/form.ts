/**
 * Hermes Session Init Form — `clarify` tool_call 载体。
 *
 * hermes（github.com/NousResearch/hermes-agent）内置交互式提问工具 `clarify`
 * （tools/clarify_tool.py，CLARIFY_SCHEMA），是 hermes 原生的交互载体。
 *
 * proxy 侧的 session-init form 复用这个 hermes 原生 tool 名，fake 一个
 * assistant tool_call SSE 让 hermes 的 agent-loop 执行 clarify → 弹原生 UI →
 * 把用户回答以 role=tool JSON 结果回填，与 dsh/workbuddy 同模式。
 *
 * # 简化版说明
 *   首版不做分页（MORE 翻页）。hermes MAX_CHOICES=4 硬限制，超过 4 个选项
 *   直接截断。后续如需分页可在此基础上加回 pageIndex + computePagination。
 *
 * # 传输
 *   协议 = OpenAI /v1/chat/completions（stream 或 non-stream）
 *   3-chunk 骨架照抄 opencode/dsh
 *
 * # 状态机
 *   完全复用 CB 状态机（session/codebuddy/init.ts），同 workbuddy/dsh/opencode
 *   模式；stage 值与 CB 完全一致，直接透传。
 *
 * # tool_call id 前缀
 *   `call_hermes_session_init_`
 */

import type { TeamOption } from "../types.js";
import { computePagination } from "../claude-code/pagination.js";

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

/** hermes MAX_CHOICES=4 硬限制。 */
const MAX_CHOICES = 4;

const SKIP_HINT = '（如选择"跳过"选项，本次 session init 将跳过，不注入任何团队资产）';

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
  pageIndex?: number;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
}

// ── clarify input schema（hermes CLARIFY_SCHEMA 的 questions[] 形态）──────────

interface HermesClarifyQuestion {
  question: string;
  choices: string[];
  multi_select: boolean;
}

export function buildClarifyArgs(data: FormData): { questions: HermesClarifyQuestion[] } {
  const { teams, stage, selectedTeamId, retry, pageIndex = 0 } = data;
  const titlePrefix = retry ? "⚠️ " : "";
  const questions: HermesClarifyQuestion[] = [];

  if (stage === "asset_confirm") {
    questions.push({
      question: titlePrefix + "本次对话是否要关联团队资产？" + SKIP_HINT,
      choices: [ASSET_CONFIRM_YES, ASSET_CONFIRM_NO],
      multi_select: false,
    });
    return { questions };
  }

  if (stage === "team") {
    const page = computePagination(teams.length, pageIndex);
    const teamOpts = teams.slice(page.start, page.end).map((t) =>
      `${t.team_name} (${t.team_id.slice(-8)})`,
    );
    if (!page.isLastPage) teamOpts.push(MORE_LABEL);
    if (teamOpts.length < 2) {
      throw new Error(
        `[hermes form] team stage requires ≥2 teams. Caller must auto-select when teams.length === 1.`,
      );
    }
    questions.push({
      question: titlePrefix + "请选择本次会话所属的 Team：" + SKIP_HINT,
      choices: teamOpts,
      multi_select: false,
    });
    return { questions };
  }

  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { questions };

  if (stage === "agent_select" || stage === "agent_task") {
    const page = computePagination(team.agents.length, pageIndex);
    const agentOpts = team.agents.slice(page.start, page.end).map((a) =>
      `${a.agent_name} (${a.agent_id.slice(-8)})`,
    );
    if (!page.isLastPage) agentOpts.push(MORE_LABEL);
    if (agentOpts.length < 2) {
      throw new Error(`[hermes form] agent stage requires ≥2 options.`);
    }
    questions.push({
      question: titlePrefix + `请选择「${team.team_name}」下要使用的 Agent：` + SKIP_HINT,
      choices: agentOpts,
      multi_select: false,
    });
    return { questions };
  }

  if (stage === "task_select") {
    const page = computePagination(team.tasks.length, pageIndex);
    const taskOpts = team.tasks.slice(page.start, page.end).map((t) =>
      t.isDefault ? t.task_name : `${t.task_name} (${t.task_id.slice(-8)})`,
    );
    if (!page.isLastPage) taskOpts.push(MORE_LABEL);
    if (taskOpts.length < 2) {
      throw new Error(`[hermes form] task stage requires ≥2 options.`);
    }
    questions.push({
      question: titlePrefix + `请选择「${team.team_name}」下要关联的任务：` + SKIP_HINT,
      choices: taskOpts,
      multi_select: false,
    });
    return { questions };
  }

  return { questions };
}

// ── Form Builder ───────────────────────────────────────────────────────────────

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
          function: { name: TOOL_NAME, arguments: argsStr },
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
      // Chunk 1: role + tool_call declaration
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

      // Chunk 2: arguments delta
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: argsStr } }],
          },
          finish_reason: null,
        }],
      })}\n\n`));

      // Chunk 3: finish
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
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
