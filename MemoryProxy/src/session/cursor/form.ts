/** Cursor native AskQuestion session-init form over OpenAI Chat Completions. */

import type { TeamOption } from "../types.js";

export const TOOL_NAME = "AskQuestion";
export const TOOLCALL_PREFIX = "call_cursor_session_init_";

export const TEAM_FORM_TITLE = "会话初始化 — 选择 Team";
export const AGENT_TASK_FORM_TITLE = "会话初始化 — 选择 Agent 与任务";
export const RETRY_FORM_TITLE = "未能识别选择，请重新选择";
export const ASSET_CONFIRM_FORM_TITLE = "会话初始化 — 是否关联团队资产";
export const ASSET_CONFIRM_YES = "是，关联团队资产";
export const ASSET_CONFIRM_NO = "否，本次不关联";
export const SKIP_LABEL = "本次不关联（跳过注入，直接放行）";

// DeepSeek thinking mode requires every replayed assistant tool-call message
// to carry a non-empty reasoning_content. Cursor preserves this field from
// the SSE/non-stream response and sends it back on the following turn. Keep
// this aligned with the battle-tested DSH form implementation.
export const REASONING_PLACEHOLDER = "[proxy session-init form]";

const SKIP_HINT = "（也可选择跳过，本次会话将不注入团队资产）";

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

interface CursorOption {
  id: string;
  label: string;
}

interface CursorQuestion {
  id: string;
  prompt: string;
  options: CursorOption[];
  allow_multiple: boolean;
}

interface CursorAskQuestionArgs {
  title: string;
  questions: CursorQuestion[];
}

function option(id: string, label: string): CursorOption {
  return { id, label };
}

function buildArgs(data: FormData): CursorAskQuestionArgs {
  const prefix = data.retry ? "⚠️ " : "";
  const team = data.teams.find((item) => item.team_id === data.selectedTeamId) ?? data.teams[0];

  if (data.stage === "asset_confirm") {
    return {
      title: ASSET_CONFIRM_FORM_TITLE,
      questions: [{
        id: "asset_confirm",
        prompt: prefix + "本次对话是否关联团队资产？" + SKIP_HINT,
        // Cursor echoes option ids in the tool result. Use the canonical
        // labels as ids so the shared CB extractor can recognize the answer.
        options: [option(ASSET_CONFIRM_YES, ASSET_CONFIRM_YES), option(ASSET_CONFIRM_NO, ASSET_CONFIRM_NO)],
        allow_multiple: false,
      }],
    };
  }

  if (data.stage === "team") {
    return {
      title: data.retry ? RETRY_FORM_TITLE : TEAM_FORM_TITLE,
      questions: [{
        id: "team_select",
        prompt: prefix + "请选择本次会话所属的 Team：" + SKIP_HINT,
        options: data.teams.map((item) => option(item.team_id, `${item.team_name} (${item.team_id.slice(-8)})`)),
        allow_multiple: false,
      }],
    };
  }

  if (!team) throw new Error("[cursor form] selected team not found");

  if (data.stage === "agent_select" || data.stage === "agent_task") {
    return {
      title: data.retry ? RETRY_FORM_TITLE : AGENT_TASK_FORM_TITLE,
      questions: [{
        id: "agent_select",
        prompt: prefix + `请选择「${team.team_name}」下要使用的 Agent：` + SKIP_HINT,
        options: team.agents.map((item) => option(item.agent_id, `${item.agent_name} (${item.agent_id.slice(-8)})`)),
        allow_multiple: false,
      }],
    };
  }

  return {
    title: data.retry ? RETRY_FORM_TITLE : AGENT_TASK_FORM_TITLE,
    questions: [{
      id: "task_select",
      prompt: prefix + `请选择「${team.team_name}」下要关联的任务：` + SKIP_HINT,
      options: team.tasks.map((item) => option(
        item.task_id,
        item.isDefault ? item.task_name : `${item.task_name} (${item.task_id.slice(-8)})`,
      )),
      allow_multiple: false,
    }],
  };
}

export function containsFormTitle(value: string): boolean {
  return [TEAM_FORM_TITLE, AGENT_TASK_FORM_TITLE, RETRY_FORM_TITLE, ASSET_CONFIRM_FORM_TITLE]
    .some((title) => value.includes(title));
}

export function isSessionInitToolCallId(id: string): boolean {
  return id.startsWith(TOOLCALL_PREFIX);
}

export function buildFormResponse(data: FormData): Response {
  const id = `cursor-session-init-${Date.now()}`;
  const toolCallId = `${TOOLCALL_PREFIX}${Date.now()}`;
  const model = data.modelId ?? "unknown";
  const created = Math.floor(Date.now() / 1000);
  const args = JSON.stringify(buildArgs(data));

  if (!data.stream) {
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
          reasoning_content: REASONING_PLACEHOLDER,
          tool_calls: [{ id: toolCallId, type: "function", function: { name: TOOL_NAME, arguments: args } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  const frames = [
    {
      id, object: "chat.completion.chunk", created, model,
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          content: null,
          reasoning_content: REASONING_PLACEHOLDER,
          tool_calls: [{
            index: 0, id: toolCallId, type: "function",
            function: { name: TOOL_NAME, arguments: "" },
          }],
        },
        finish_reason: null,
      }],
    },
    {
      id, object: "chat.completion.chunk", created, model,
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: args } }] },
        finish_reason: null,
      }],
    },
    {
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
    {
      id, object: "chat.completion.chunk", created, model,
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
  ];
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
