/**
 * CodeBuddy Session Init Form — `AskUserQuestion` tool_call.
 *
 * CodeBuddy CLI（@tencent-ai/codebuddy-code）内置的交互提问工具是
 * `AskUserQuestion`（与 Claude Code 同名），参数格式为
 * `{ questions: [{ question, header, options: [{label, description}], multiSelect }] }`。
 * 早期版本误用 `ask_followup_question`（CodeBuddy IDE 插件工具名），CLI 工具集
 * 中不存在该工具，导致表单无法弹出（"Tool does not exist in the current tool set"）。
 *
 *   - Tool name: `AskUserQuestion`
 *   - Options: `{ label, description }` 结构体
 *   - Protocols: OpenAI (`/v1/chat/completions`) + Anthropic (`/v1/messages`)
 *   - ID prefix: `call_session_init_` (OpenAI) / `toolu_session_init_` (Anthropic)
 */

import type { TeamOption } from "../types.js";
import { QUESTION_IDS, type QuestionId } from "./adapter.js";

// ── Constants ──────────────────────────────────────────────────────────────────

export const TOOL_NAME = "AskUserQuestion";
export const TOOLCALL_PREFIXES = ["call_session_init_", "toolu_session_init_"] as const;

export const TEAM_FORM_TITLE = "会话初始化 — 选择 Team";
export const AGENT_TASK_FORM_TITLE = "会话初始化 — 选择 Agent 与任务";
export const RETRY_FORM_TITLE = "未能识别选择，请重新选择";
/** 兼容旧测试的总标题（cleaner.ts 检测用）。 */
export const COMBINED_FORM_TITLE = "会话初始化 — 选择 Team / Agent / 任务";

export const SKIP_LABEL = "本次不关联（跳过注入，直接放行）";
export const PATH_SEP = " / ";

export const ASSET_CONFIRM_YES = "是，关联团队资产";
export const ASSET_CONFIRM_NO = "否，本次不关联";
export const ASSET_CONFIRM_FORM_TITLE = "会话初始化 — 是否关联团队资产";

/** Returns true if the given string contains any CodeBuddy form title marker. */
export function containsFormTitle(s: string): boolean {
  return (
    s.includes(COMBINED_FORM_TITLE) ||
    s.includes(TEAM_FORM_TITLE) ||
    s.includes(AGENT_TASK_FORM_TITLE) ||
    s.includes(RETRY_FORM_TITLE) ||
    s.includes(ASSET_CONFIRM_FORM_TITLE)
  );
}

/** Returns true if a tool_call id belongs to a CodeBuddy session-init form. */
export function isSessionInitToolCallId(id: string): boolean {
  return TOOLCALL_PREFIXES.some((p) => id.startsWith(p));
}

// ── Form Data ──────────────────────────────────────────────────────────────────

export type FormStage = "asset_confirm" | "team" | "agent_task";

export interface FormData {
  teams: TeamOption[];
  stage: FormStage;
  selectedTeamId?: string;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
  protocol?: "openai" | "anthropic";
}

// ── Form Builder ───────────────────────────────────────────────────────────────

interface CBAskOption {
  label: string;
  description: string;
}

interface CBAskQuestion {
  /** 稳定 question id（946-B §18.1）：显示 label 不作标识，解析按此 id 路由。 */
  id: QuestionId;
  question: string;
  header: string;
  options: CBAskOption[];
  multiSelect: boolean;
}

function buildFollowupQuestionArgs(data: FormData): { questions: CBAskQuestion[] } {
  const { teams, stage, selectedTeamId, retry } = data;

  const titlePrefix = retry ? "⚠️ " : "";
  const questions: CBAskQuestion[] = [];

  if (stage === "asset_confirm") {
    questions.push({
      id: QUESTION_IDS.assetConfirm,
      question: titlePrefix + ASSET_CONFIRM_FORM_TITLE + "：本次对话是否要关联团队资产？",
      header: "关联资产",
      options: [
        { label: ASSET_CONFIRM_YES, description: "选择 Team / Agent / Task，注入团队上下文" },
        { label: ASSET_CONFIRM_NO, description: "本次不注入任何内容，直接放行" },
      ],
      multiSelect: false,
    });
    return { questions };
  }

  if (stage === "team") {
    questions.push({
      id: QUESTION_IDS.team,
      question: titlePrefix + TEAM_FORM_TITLE + "：请选择本次会话所属的 Team：",
      header: "Team",
      options: teams.map((t) => ({
        label: `${t.team_name} (${t.team_id.slice(-8)})`,
        description: "",
      })),
      multiSelect: false,
    });
    return { questions };
  }

  // stage === "agent_task"
  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { questions };

  if (team.agents.length > 0) {
    questions.push({
      id: QUESTION_IDS.agent,
      question: titlePrefix + AGENT_TASK_FORM_TITLE + `：请选择「${team.team_name}」下要使用的 Agent：`,
      header: "Agent",
      options: team.agents.map((a) => ({
        label: `${a.agent_name} (${a.agent_id.slice(-8)})`,
        description: a.description ?? "",
      })),
      multiSelect: false,
    });
  }

  const taskOptions: CBAskOption[] = [];
  for (const tk of team.tasks) {
    // 虚拟兜底条目（isDefault）不拼 id 后缀，反正只有一个不会重名歧义。
    taskOptions.push({
      label: tk.isDefault ? tk.task_name : `${tk.task_name} (${tk.task_id.slice(-8)})`,
      description: "",
    });
  }
  if (taskOptions.length > 0) {
    questions.push({
      id: QUESTION_IDS.task,
      question: titlePrefix + AGENT_TASK_FORM_TITLE + `：请选择「${team.team_name}」下关联的任务：`,
      header: "Task",
      options: taskOptions,
      multiSelect: false,
    });
  }

  return { questions };
}

/**
 * Build a fake form response (OpenAI or Anthropic protocol).
 * CodeBuddy 支持双协议：
 *   - protocol="openai": tool_calls chunk stream 或 JSON
 *   - protocol="anthropic": tool_use SSE stream 或 JSON
 */
export function buildFormResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const created = Math.floor(Date.now() / 1000);
  const args = buildFollowupQuestionArgs(data);

  if (data.protocol === "anthropic") {
    const msgId = "msg_session_init_" + Date.now();
    const toolUseId = "toolu_session_init_" + Date.now();
    if (data.stream) {
      return buildAnthropicStreamingResponse(msgId, model, toolUseId, args);
    }
    return buildAnthropicNonStreamingResponse(msgId, model, toolUseId, args);
  }

  const id = "session-init-" + Date.now();
  const toolCallId = "call_session_init_" + Date.now();
  if (data.stream) {
    return buildOpenAIStreamingResponse(id, created, model, toolCallId, args);
  }
  return buildOpenAINonStreamingResponse(id, created, model, toolCallId, args);
}

// ── OpenAI Non-streaming ───────────────────────────────────────────────────────

function buildOpenAINonStreamingResponse(
  id: string,
  created: number,
  model: string,
  toolCallId: string,
  args: { questions: CBAskQuestion[] },
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
            arguments: JSON.stringify(args),
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
  args: { questions: CBAskQuestion[] },
): Response {
  const encoder = new TextEncoder();
  const argsStr = JSON.stringify(args);

  const stream = new ReadableStream({
    start(controller) {
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

// ── Anthropic Non-streaming ────────────────────────────────────────────────────

function buildAnthropicNonStreamingResponse(
  msgId: string,
  model: string,
  toolUseId: string,
  args: { questions: CBAskQuestion[] },
): Response {
  return new Response(JSON.stringify({
    id: msgId,
    type: "message",
    role: "assistant",
    model,
    content: [{
      type: "tool_use",
      id: toolUseId,
      name: TOOL_NAME,
      input: args,
    }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ── Anthropic Streaming ────────────────────────────────────────────────────────

function buildAnthropicStreamingResponse(
  msgId: string,
  model: string,
  toolUseId: string,
  args: { questions: CBAskQuestion[] },
): Response {
  const encoder = new TextEncoder();
  const inputJson = JSON.stringify(args);
  const sse = (event: string, d: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(d)}\n\n`);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(sse("message_start", {
        type: "message_start",
        message: {
          id: msgId, type: "message", role: "assistant", model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));

      controller.enqueue(sse("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: toolUseId, name: TOOL_NAME, input: {} },
      }));

      controller.enqueue(sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: inputJson },
      }));

      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 0 }));

      controller.enqueue(sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 0 },
      }));

      controller.enqueue(sse("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
}
