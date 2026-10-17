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
 * # 传输(双协议)
 *   - dsh v0.1.x(老 llm-deepseek adapter): **OpenAI /v1/chat/completions**
 *   - dsh v0.2+(新 llm-deepseek-api-key adapter, 抓包 2026-09-29 实证):
 *     **Anthropic /v1/messages**(headers 带 `anthropic-version: 2023-06-01`,
 *     路径拼 `${baseURL}/v1/messages`,见 dsh 源码
 *     `packages/llm/llm-deepseek/src/adapter.ts:120-131`)
 *   - 分支由 FormData.protocol 决定:"anthropic" | "openai"|undefined(=openai)
 *   - SSE stream 或 non-stream(与请求 `body.stream` 保持一致)
 *   - openai 骨架照抄 workbuddy;anthropic 骨架照抄 claude-code/form.ts
 *     (message_start → thinking block → tool_use block → message_stop)
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

export const SKIP_LABEL = "本次不关联（跳过注入，直接放行）";
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

/**
 * anthropic 分支专用:fake `thinking` block 的固定 placeholder signature。
 *
 * 与 claude-code/form.ts 的 THINKING_SIGNATURE_PLACEHOLDER 完全等价 —— 同一份
 * base64 字符串,同一份合规理由:
 *   - DeepSeek 官方 Anthropic 兼容端点在 thinking mode 下强查历史 assistant
 *     必须带 thinking block,否则 400
 *     `The content[].thinking in the thinking mode must be passed back to the API`
 *   - proxy 自己的 `sanitizeThinkingBlocks` (`anthropicHandler.ts:280`) 要求
 *     signature 满足 `^[A-Za-z0-9+/=]+$` + 长度 ≥ 40 + 不是 UUID —— 此值全命中
 *   - 真 Anthropic 上游只在请求本身开 thinking mode 时才做 crypto 校验;fake
 *     session-init 不真过模型
 *
 * 详细分析见 claude-code/form.ts:83 THINKING_SIGNATURE_PLACEHOLDER 注释。
 */
const THINKING_SIGNATURE_PLACEHOLDER =
  "UHJveHlDQ1Nlc3Npb25Jbml0RmFrZVRoaW5raW5nUGxhY2Vob2xkZXJTaWc=";

export const ASSET_CONFIRM_YES = "是，关联团队资产";
export const ASSET_CONFIRM_NO = "否，本次不关联";
export const ASSET_CONFIRM_FORM_TITLE = "会话初始化 — 是否关联团队资产";

/**
 * 附在每步 question 文末的通用备注。
 * dsh 的 ask_user_question UI 也支持 "Other"/自由文本兜底（见 dsh 文档 §3.4
 * `custom` 字段）；回复"跳过 / skip / 不关联"会走 SKIP_RE bypass。
 * 文案与 claude-code/workbuddy/codex/codebuddy 五端统一。
 */
const SKIP_HINT = '（请选择最匹配的选项，当前暂不支持自定义输入。若选择跳过，本次 Session 将不注入团队资产）';

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
  /**
   * 传输协议 —— 决定 buildFormResponse 走哪个 SSE 骨架。
   *   - "anthropic"(dsh v0.2+ llm-deepseek-api-key adapter): message_start
   *     → thinking → tool_use SSE
   *   - "openai" 或 undefined(dsh v0.1.x 老 adapter): chat.completion.chunk
   *     tool_calls SSE
   * 由 handler 层构建 reqCtx 时透传:anthropicHandler.ts 传 "anthropic",
   * handler.ts 传 "openai"(见 session/index.ts dsh 分派)。
   */
  protocol?: "openai" | "anthropic";
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
    // team.tasks[0] 是虚拟 default 任务("暂时跳过"),源头 unshift 一次,
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
 * 双协议分支(见 FormData.protocol):
 *   - "anthropic" (dsh v0.2+ llm-deepseek-api-key adapter): Anthropic SSE
 *   - "openai" 或 undefined (dsh v0.1.x 老 adapter): OpenAI chat.completion(.chunk)
 * arguments shape 完全一致:dsh 原生
 *   `{questions: [{id, question, header, options, multi_select}]}`。
 */
export function buildFormResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const input = buildAskUserQuestionArgs(data);
  const argsStr = JSON.stringify(input);

  if (data.protocol === "anthropic") {
    // dsh v0.2+ 走 anthropic /v1/messages(dsh llm-deepseek-api-key adapter,
    // 抓包实证 2026-09-29;详见文件头 "传输" 段)。
    // 无 non-stream 分支:dsh anthropic adapter 硬编码 `accept: text/event-stream`
    // (adapter.ts:124),真实客户端永远走 SSE;可能存在的 non-stream 探针路径
    // 直接复用 SSE 响应,anthropic SDK 也能一次性收全。
    const msgId = "msg_dsh_session_init_" + Date.now();
    const toolUseId = TOOLCALL_PREFIX + Date.now();
    return buildAnthropicStreamingResponse(msgId, model, toolUseId, argsStr);
  }

  // openai 分支(老 dsh v0.1.x / 未来 openai-shape 客户端)
  const created = Math.floor(Date.now() / 1000);
  const id = "dsh-session-init-" + Date.now();
  const toolCallId = TOOLCALL_PREFIX + Date.now();
  if (data.stream) {
    return buildOpenAIStreamingResponse(id, created, model, toolCallId, argsStr);
  }
  return buildOpenAINonStreamingResponse(id, created, model, toolCallId, argsStr);
}

// ── Anthropic Streaming(dsh v0.2+ /v1/messages) ─────────────────────────────

/**
 * Anthropic SSE 骨架,与 claude-code/form.ts buildFormResponse 完全对称。
 * 关键 3 层:
 *   1. thinking block (index 0):无条件 emit,防 DeepSeek thinking-mode 400
 *   2. tool_use block (index 1):dsh 原生 `ask_user_question` name + 完整 input
 *   3. message_delta stop_reason=tool_use
 */
function buildAnthropicStreamingResponse(
  msgId: string,
  model: string,
  toolUseId: string,
  inputJson: string,
): Response {
  const encoder = new TextEncoder();
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

      // ── Fake `thinking` block (index 0) ──────────────────────────────────
      // 无条件 emit —— DeepSeek 官方 Anthropic 兼容端点在 thinking mode 下强查
      // 历史 assistant 必须带 thinking block,否则 400。详见
      // THINKING_SIGNATURE_PLACEHOLDER 常量注释。
      controller.enqueue(sse("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }));

      controller.enqueue(sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "" },
      }));

      controller.enqueue(sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: THINKING_SIGNATURE_PLACEHOLDER },
      }));

      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 0 }));

      // ── tool_use block (index 1) ─────────────────────────────────────────
      controller.enqueue(sse("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: toolUseId,
          name: TOOL_NAME,
          input: {},
        },
      }));

      controller.enqueue(sse("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: inputJson },
      }));

      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 1 }));

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
