/**
 * dsh Session Init Form — `ask_user_question` tool_call 载体。
 *
 * dsh(deepseek-harness)客户端在 preset 场景(web-app + standard/code/cordis
 * 等 preset)会自动挂 `@deepseek-ai/dsh-tool-ask-user`,给主对话 tools 数组
 * 加一个 `ask_user_question` 工具(见 dsh 源码
 * `packages/interaction/tool-ask-user/src/index.ts`)。
 *
 * proxy 侧的 session-init form 直接复用这个 dsh 原生 tool 名,fake 一个
 * assistant tool_call SSE 让客户端 UI 渲染选项。
 *
 * # 与 workbuddy form 的差异(3 处 shape 差异 + tool name)
 *   - tool_name: `AskUserQuestion` → `ask_user_question`
 *   - multiSelect (camelCase) → multi_select (snake_case)
 *   - 每题必填 `id`(dsh schema 硬约束,echoed in answer)
 *   - 顶层 `questions[]` 一次可发多题(workbuddy/CC 通常单题;这里为对齐 dsh
 *     schema 保留数组结构,单题就一元素数组)
 *
 * # 传输
 *   - 协议 = **OpenAI /v1/chat/completions**(与 dsh 客户端 fetch 一致)
 *   - SSE stream 或 non-stream(与请求 `body.stream` 保持一致)
 *   - 骨架完全照抄 workbuddy(chunk 1 = role+tool_call decl / chunk 2 =
 *     arguments delta / chunk 3 = finish_reason:tool_calls / DONE)
 *
 * # 状态机
 *   - 完全复用 CB 状态机(session/codebuddy/init.ts),同 workbuddy 模式;
 *     stage 值(asset_confirm / team / agent_select / task_select / agent_task)
 *     与 CB 完全一致,直接透传
 *
 * # tool_call id 前缀
 *   - `call_dsh_session_init_` —— 区分于 CB(`call_session_init_`)、
 *     workbuddy(`call_wb_session_init_`)、codex(`fc_codex_session_init_`)
 *
 * # 抓包 schema 依据
 *   - `docs/dsh-recon/fixtures/dsh-tool-catalog-schema.json`
 *   - dsh 源码 `packages/interaction/tool-ask-user/src/index.ts`
 */

import type { TeamOption } from "../types.js";
// dsh (deepseek-harness) 的 ask_user_question UI 无 options 数量上限
// (源码 packages/interaction/tool-ask-user/src/index.ts + UI QuestionComposer.tsx
// 都直接 map 渲染,无截断)。因此 dsh form **不分页**,team/agent/task 全量塞。
// 对比:CC 硬要求 ≤4 options(AskUserQuestion 内部校验),必须分页;codex 有类似
// 限制;CB 无限制也不分页。dsh 属于"UI 无限制"类。
// 详见:MemoryProxy/docs/dsh-recon/2026-08-14-dsh-integration-notes.md 坑 #9。

// ── Constants ──────────────────────────────────────────────────────────────────

/** dsh 原生 tool 名。**不要**改成 CC 的 `AskUserQuestion`——dsh preset 挂的是 snake_case。 */
export const TOOL_NAME = "ask_user_question";
export const TOOLCALL_PREFIX = "call_dsh_session_init_";

export const TEAM_FORM_TITLE = "会话初始化 — 选择 Team";
export const AGENT_TASK_FORM_TITLE = "会话初始化 — 选择 Agent 与任务";
export const RETRY_FORM_TITLE = "未能识别选择,请重新选择";

export const SKIP_LABEL = "本次不关联(跳过注入,直接放行)";
// dsh 不分页,MORE_LABEL 保留仅作向后兼容(测试或未来切分页时用);当前不产出。
export const MORE_LABEL = "更多 →";

/**
 * fake tool_call assistant 消息的占位 reasoning_content。
 *
 * ## 为什么必须非空
 *
 * dsh `serialize.ts:99` 只在 `toolCalls.length > 0 && reasoning.length > 0` 时才
 * 回传 reasoning_content 到上游 body。dsh `translate.ts:133` 入站解析也一样,
 * `reasoning_content.length > 0` 才开一个 reasoning block —— **空串直接吃掉**。
 *
 * 空串 `""` = 客户端解析出 `text: ""` 的 block → serialize join 后 length 0
 * → 上游 body 缺 reasoning_content → deepseek thinking 模式硬校验 400
 * `The reasoning_content in the thinking mode must be passed back to the API`。
 *
 * 塞一个非空占位就能让客户端真开一个 reasoning block,下一轮 replay 时带上。
 * 值本身对模型无影响(反正 fake session-init 也不真过模型)。
 *
 * 见 docs/dsh-recon/2026-08-14-dsh-integration-notes.md 坑 #7。
 */
const REASONING_PLACEHOLDER = "[proxy session-init form]";

export const ASSET_CONFIRM_YES = "是,关联团队资产";
export const ASSET_CONFIRM_NO = "否,本次不关联";
export const ASSET_CONFIRM_FORM_TITLE = "会话初始化 — 是否关联团队资产";

/**
 * 附在每步 question 文末的通用备注：告诉用户"选择跳过 = 本次 session init 跳过、不注入任何团队资产"。
 * dsh 的 ask_user_question UI 也支持 "Other"/自由文本兜底（见 dsh 文档 §3.4
 * `custom` 字段）；回复"跳过 / skip / 不关联"会走 SKIP_RE bypass。
 * 文案与 claude-code/workbuddy/codex/codebuddy 五端统一（此处也一并从半角改为全角标点）。
 */
const SKIP_HINT = '（如选择"跳过"选项，本次 session init 将跳过，不注入任何团队资产）';

/** Returns true if the given string contains any dsh form title marker. */
export function containsFormTitle(s: string): boolean {
  return (
    s.includes(TEAM_FORM_TITLE) ||
    s.includes(AGENT_TASK_FORM_TITLE) ||
    s.includes(RETRY_FORM_TITLE) ||
    s.includes(ASSET_CONFIRM_FORM_TITLE)
  );
}

/** Returns true if a tool_call id belongs to a dsh session-init form. */
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
  /** @deprecated dsh 不分页(见文件头);字段保留为兼容 session/index.ts dispatch 时透传,builder 忽略。 */
  pageIndex?: number;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
}

// ── ask_user_question input schema (dsh snake_case + 必填 id) ──────────────────

interface DshAskQuestionOption {
  label: string;
  description: string;
}

interface DshAskQuestion {
  /** dsh schema 硬要求,echoed in answer;proxy 生成稳定 id(题目名短标签)。 */
  id: string;
  question: string;
  header: string;
  options: DshAskQuestionOption[];
  /** dsh 是 snake_case,与 CC 的 multiSelect camelCase 不同。 */
  multi_select: boolean;
}

function buildAskUserQuestionArgs(data: FormData): { questions: DshAskQuestion[] } {
  const { teams, stage, selectedTeamId, retry } = data;
  const titlePrefix = retry ? "⚠️ " : "";
  const questions: DshAskQuestion[] = [];

  if (stage === "asset_confirm") {
    questions.push({
      id: "asset_confirm",
      question: titlePrefix + "本次对话是否要关联团队资产?" + SKIP_HINT,
      header: "关联资产",
      options: [
        { label: ASSET_CONFIRM_YES, description: "选择 Team / Agent / Task,注入团队上下文" },
        { label: ASSET_CONFIRM_NO, description: "本次不注入任何内容,直接放行" },
      ],
      multi_select: false,
    });
    return { questions };
  }

  if (stage === "team") {
    // dsh 无 options 数量上限,全量渲染,不分页(见文件头注释)。
    const teamOpts: DshAskQuestionOption[] = teams.map((t) => ({
      label: `${t.team_name} (${t.team_id.slice(-8)})`,
      description: "",
    }));
    if (teamOpts.length < 2) {
      throw new Error(
        `[dsh form] team stage requires ≥2 teams (got ${teamOpts.length}). ` +
          `Caller must auto-select when teams.length === 1.`,
      );
    }
    questions.push({
      id: "team_select",
      question: titlePrefix + "请选择本次会话所属的 Team:" + SKIP_HINT,
      header: "Team",
      options: teamOpts,
      multi_select: false,
    });
    return { questions };
  }

  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { questions };

  if (stage === "agent_select" || stage === "agent_task") {
    // dsh 无 options 数量上限,全量渲染,不分页。
    const combinedOptions: DshAskQuestionOption[] = team.agents.map((a) => ({
      label: `${a.agent_name} (${a.agent_id.slice(-8)})`,
      description: a.description ?? "",
    }));

    if (combinedOptions.length < 2) {
      throw new Error(
        `[dsh form] agent stage requires ≥2 agents (got ${combinedOptions.length}). ` +
          `Caller must handle single-agent auto-select upstream.`,
      );
    }

    questions.push({
      id: "agent_select",
      question: titlePrefix + `请选择「${team.team_name}」下要使用的 Agent:` + SKIP_HINT,
      header: "Agent",
      options: combinedOptions,
      multi_select: false,
    });
    return { questions };
  }

  if (stage === "task_select") {
    // dsh 无 options 数量上限,全量渲染,不分页。
    // team.tasks[0] 是虚拟 default 任务("本次不关联任务"),源头 unshift 一次,
    // 不分页就不会像旧版每页都出现在开头(踩坑文档 §6 坑 #9)。
    const taskOpts: DshAskQuestionOption[] = team.tasks.map((t) => ({
      label: t.isDefault
        ? t.task_name
        : `${t.task_name} (${t.task_id.slice(-8)})`,
      description: "",
    }));

    if (taskOpts.length < 2) {
      throw new Error(
        `[dsh form] task stage requires ≥2 tasks (got ${taskOpts.length}). ` +
          `Default task should always be prepended by fetchTeamsAndAgents.`,
      );
    }

    questions.push({
      id: "task_select",
      question: titlePrefix + `请选择「${team.team_name}」下要关联的任务:` + SKIP_HINT,
      header: "Task",
      options: taskOpts,
      multi_select: false,
    });
    return { questions };
  }

  return { questions };
}

// ── Form Builder ───────────────────────────────────────────────────────────────

/**
 * Build a dsh `ask_user_question` fake form response.
 *
 * 传输:**OpenAI chat/completions**(stream 或 non-stream)。
 * arguments shape:dsh 原生 `{questions: [{id, question, header, options, multi_select}]}`。
 */
export function buildFormResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const created = Math.floor(Date.now() / 1000);
  const id = "dsh-session-init-" + Date.now();
  const toolCallId = TOOLCALL_PREFIX + Date.now();
  const input = buildAskUserQuestionArgs(data);
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
        // deepseek thinking 模式强约束 —— 完整分析见 REASONING_PLACEHOLDER 定义。
        // 关键:必须**非空**,否则客户端 translate.ts:133 遇 `reasoning.length > 0`
        // 判据吃掉,serialize.ts:99 输出侧再判 length 0 → 上游 body 缺字段 → 400。
        reasoning_content: REASONING_PLACEHOLDER,
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
      // Chunk 1: role + tool_call declaration (empty arguments) + reasoning_content
      // reasoning_content 必须**非空**(值 = REASONING_PLACEHOLDER)—— 空串会被
      // dsh translate.ts:133 吃掉,serialize 时不回传,上游 400。
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            reasoning_content: REASONING_PLACEHOLDER,
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
