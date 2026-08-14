/**
 * Codex Session Init Form — `request_user_input` function_call.
 *
 * Codex 客户端 form 协议：
 *   - Tool name: `request_user_input`
 *   - 参数: `{questions: [{prompt, options?}, ...]}`
 *   - Protocol: OpenAI Responses API（SSE `response.*` 事件序列）
 *   - ID prefix: `call_codex_session_init_`
 *   - Plan 模式门控: Default 模式下客户端 gate 拦截，返回
 *     `"request_user_input is unavailable in Default mode"`
 *
 * 不含任何 Claude Code / CodeBuddy 逻辑。
 */

import type { TeamOption } from "../types.js";
import { computeCodexPagination } from "./pagination.js";

// ── Constants ──────────────────────────────────────────────────────────────────

export const TOOL_NAME = "request_user_input";
/**
 * `function_call.call_id` 前缀 —— codex 客户端把 form 结果 replay 回 input[]
 * 时用 `call_id` 关联到 `function_call_output`，此字段 OpenAI Responses 规范
 * 允许自由格式，回读时用这个前缀识别是不是 session-init。
 */
export const TOOLCALL_PREFIX = "call_codex_session_init_";
/**
 * `function_call.id` 前缀 —— OpenAI Responses 规范硬性要求 `id` 必须以 `fc`
 * 开头（`fc_xxxxxxxxxxxx`）。之前 id 也用 TOOLCALL_PREFIX（call_ 起头），
 * 严格执行该规范的 Responses API 上游会在客户端 replay 到 input[] 时返 400：
 *   Invalid 'input[N].id': 'call_codex_session_init_xxx'.
 *   Expected an ID that begins with 'fc'.
 * 见 2026-08-13 用户抓包报错。call_id 保持 call_ 前缀，仅 id 用 fc_。
 */
export const TOOLCALL_ID_PREFIX = "fc_codex_session_init_";

export const TEAM_FORM_TITLE = "会话初始化 — 选择 Team";
export const AGENT_TASK_FORM_TITLE = "会话初始化 — 选择 Agent 与任务";
export const RETRY_FORM_TITLE = "未能识别选择，请重新选择";

export const ASSET_CONFIRM_YES = "是，关联团队资产";
export const ASSET_CONFIRM_NO = "否，本次不关联";
export const ASSET_CONFIRM_FORM_TITLE = "会话初始化 — 是否关联团队资产";

/**
 * codex 分页 "更多..." 选项的稳定标记（写在 option.label 里，用户点了会
 * 原样回到 codex handler，我们据此拦截 → pageIndex++ 重发下一页 form）。
 *
 * MARKER 是内部识别用的稳定字符串（对齐 CC MORE_MARKER 命名），LABEL 是
 * 面向用户的可读中文（"更多..."）。extract 时按 LABEL 子串匹配即可，
 * MARKER 本身不进 label（避免"__..."字符污染 UI 显示）。
 */
export const CODEX_MORE_MARKER = "__codex_more_marker__" as const;
export const CODEX_MORE_LABEL = "更多...";

/**
 * 客户端 Default 模式下 gate 拦截的前缀字符串。
 * `function_call_output.output` 以此开头时，判定为 gate 命中。
 */
export const DEFAULT_GATE_PREFIX = "request_user_input is unavailable in";

/**
 * 附在每步 question 文末的通用备注：告诉用户"选择跳过 = 本次 session init 跳过、不注入任何团队资产"。
 * Codex 的 request_user_input 在 Plan 模式下展示 questions + options 给用户；
 * 跳过入口为「否，本次不关联」按钮。文案与 claude-code/workbuddy/codebuddy/dsh 五端统一。
 */
const SKIP_HINT = '（如选择"跳过"选项，本次 session init 将跳过，不注入任何团队资产）';

/** Returns true if the given string contains any codex form title marker. */
export function containsFormTitle(s: string): boolean {
  return (
    s.includes(TEAM_FORM_TITLE) ||
    s.includes(AGENT_TASK_FORM_TITLE) ||
    s.includes(RETRY_FORM_TITLE) ||
    s.includes(ASSET_CONFIRM_FORM_TITLE)
  );
}

/** Returns true if a function_call id belongs to a codex session-init form. */
export function isSessionInitToolCallId(id: string): boolean {
  return id.startsWith(TOOLCALL_PREFIX);
}

/**
 * 判定 `function_call_output.output` 是否为客户端 Default 模式 gate 拦截。
 * gate 字符串 startsWith `"request_user_input is unavailable in"`。
 */
export function isDefaultModeGate(output: string): boolean {
  return output.startsWith(DEFAULT_GATE_PREFIX);
}

// ── Form Data ──────────────────────────────────────────────────────────────────

/**
 * codex form 支持的 stage 枚举。
 *
 * 2026-08-08 重构：把老 "agent_task"（一发同时问 agent+task）在 codex 侧拆成
 * 两个独立 stage："agent_select" 只问 agent，"task_select" 只问 task。原因见
 * docs & task-brief：老 stage 让 partialMore（agent 真选 + task=更多）无法回到
 * 同一 stage 重问 task，用户翻页永远看第一页。
 *
 * 老 "agent_task" 值保留（用于 CB 客户端复用 CB 状态机时的 legacy 路径与旧
 * 单元测试），codex 新会话不再使用它。
 */
export type FormStage = "asset_confirm" | "team" | "agent_select" | "task_select" | "agent_task";

export interface FormData {
  teams: TeamOption[];
  stage: FormStage;
  selectedTeamId?: string;
  /**
   * 已在 agent_select 阶段选定的 agent_id。task_select stage 渲染任务列表时
   * 该字段目前仅用于日志/回显——tasks 是 team-wide 的，不受 agent 影响。
   * 未来若引入 agent-scoped task 列表可直接派上用场。
   */
  selectedAgentId?: string;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
  /**
   * codex 分页页码（0-based）。三个 stage 各自独立：
   *   - teamPage:  team stage
   *   - agentPage: agent_select stage（及 legacy agent_task 的 agent 问题）
   *   - taskPage:  task_select stage（及 legacy agent_task 的 task 问题）
   *
   * 缺省全部按 0 处理。codex handler 从 sessionStore 的 codexPageIndex
   * 字段读出并传下来；用户答 "更多..." 时 handler 拦截并 +1 重发。
   */
  teamPage?: number;
  agentPage?: number;
  taskPage?: number;
}

// ── Answer extraction ────────────────────────────────────────────────────────

/**
 * 把 codex `body.input[]` 里 session-init form 的 `function_call_output` 提取
 * 成 CB 兼容的 `messages[]`（一条 `role: "user"` 消息，content 是拼接后的答案
 * 文本），以便复用 CB 的 `handleSessionInit` 状态机（不需要再造一套 codex 侧
 * 的 extractor / state machine）。
 *
 * 只取**最后一个** call_id 以 `call_codex_session_init_` 起头的
 * `function_call_output`，因为 codex 客户端会全量重放 input[]，累积多轮 form
 * 答案；CB 状态机每次只关心最新一步。
 *
 * `output` 可能是：
 *   - 纯字符串答案：`"是，关联团队资产"`
 *   - JSON 字符串 `{"answers":{"q1":"是"}}`（不同版本 codex 客户端可能不同）
 *   - JSON 字符串 `{"question":"...","answer":"..."}` 或数组
 * 兜底策略：能解析出结构化 answer 值就拼接返回，否则直接用原始字符串。
 *
 * 返回空数组 → CB 会走 `pending_*` 分支的重试/兜底逻辑。
 */
export function codexFormAnswersAsMessages(input: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(input)) return [];

  let lastOutput: string | null = null;
  for (const item of input) {
    const it = item as Record<string, unknown> | null;
    if (!it || typeof it !== "object") continue;
    if (it.type !== "function_call_output") continue;
    const callId = it.call_id;
    if (typeof callId !== "string" || !callId.startsWith(TOOLCALL_PREFIX)) continue;
    const output = it.output;
    if (typeof output === "string") lastOutput = output;
  }

  if (lastOutput === null) return [];

  const text = extractAnswerText(lastOutput);
  if (!text) return [];

  return [{ role: "user", content: text }];
}

/**
 * 尝试把 codex `function_call_output.output` 里的答案文本抽出来。
 *
 * codex `request_user_input` 的 tool_result 结构在不同客户端版本 / 语言下略有
 * 差异——先尝试 JSON 解析常见几种 shape，都不匹配就退回原始字符串（CB 的
 * 匹配器本来就是子串兜底，能命中 option label 就行）。
 */
function extractAnswerText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  // 非 JSON 前缀 → 直接原样返回。
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;

  try {
    const parsed = JSON.parse(trimmed);
    const collected: string[] = [];
    collectAnswerStrings(parsed, collected);
    if (collected.length > 0) return collected.join("\n");
  } catch {
    // JSON parse 失败 → 回退到原始字符串
  }
  return trimmed;
}

/**
 * 扫描 codex `body.input[]` 里最后一次 session-init form 的
 * `function_call_output`，按 question id 提取 MORE 标记命中情况。
 *
 * 用法：在 handleSessionInit 前拦截 —— 命中就 pageIndex+1，
 * 直接重发 form，不推进 CB 状态机。
 *
 * 返回：
 *   - hasMore: 至少一个 question 的答案含 CODEX_MORE_LABEL
 *   - perQuestion: 各 question id 是否命中 MORE
 *
 * 对齐 `codexFormAnswersAsMessages`：只取最后一个 call_id 以
 * `call_codex_session_init_` 起头的 `function_call_output`。
 *
 * 兼容多种 output 格式：
 *   - 纯字符串（单题）
 *   - JSON: `{"answers":{"team_select":"更多..."}}`
 *   - JSON: `{"answers":{"agent_select":"agent-1","task_select":"更多..."}}`
 *   - JSON: multi_question_result envelope
 *
 * 不解析的格式退化为"只按纯字符串检查 CODEX_MORE_LABEL 子串"——
 * 此时 perQuestion 全 false（调用方按 state.status 自己决定该 bump 哪个）。
 */
export interface CodexMoreDetection {
  hasMore: boolean;
  perQuestion: {
    team_select: boolean;
    agent_select: boolean;
    task_select: boolean;
  };
}

export function detectCodexMore(input: unknown): CodexMoreDetection {
  const result: CodexMoreDetection = {
    hasMore: false,
    perQuestion: { team_select: false, agent_select: false, task_select: false },
  };
  if (!Array.isArray(input)) return result;

  let lastOutput: string | null = null;
  for (const item of input) {
    const it = item as Record<string, unknown> | null;
    if (!it || typeof it !== "object") continue;
    if (it.type !== "function_call_output") continue;
    const callId = it.call_id;
    if (typeof callId !== "string" || !callId.startsWith(TOOLCALL_PREFIX)) continue;
    const output = it.output;
    if (typeof output === "string") lastOutput = output;
  }
  if (lastOutput === null) return result;

  const trimmed = lastOutput.trim();
  if (!trimmed) return result;

  // 尝试结构化解析
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      collectMorePerQuestion(parsed, result);
    } catch {
      // ignore
    }
  }

  // 兜底：整段文本子串匹配
  if (lastOutput.includes(CODEX_MORE_LABEL)) {
    result.hasMore = true;
  }
  // 若结构化解析命中任何 perQuestion，也要把 hasMore 打上
  if (
    result.perQuestion.team_select ||
    result.perQuestion.agent_select ||
    result.perQuestion.task_select
  ) {
    result.hasMore = true;
  }

  return result;
}

function collectMorePerQuestion(node: unknown, out: CodexMoreDetection): void {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;

  // { answers: { q_id: label } }
  if (obj.answers && typeof obj.answers === "object") {
    const answers = obj.answers as Record<string, unknown>;
    for (const [qid, val] of Object.entries(answers)) {
      if (typeof val !== "string") continue;
      if (!val.includes(CODEX_MORE_LABEL)) continue;
      if (qid === "team_select" || qid === "agent_select" || qid === "task_select") {
        (out.perQuestion as Record<string, boolean>)[qid] = true;
      }
    }
  }

  // { type: "multi_question_result", questions: [{id, answer}] }
  const mqr = (obj.result ?? obj) as Record<string, unknown> | undefined;
  if (mqr && mqr.type === "multi_question_result" && Array.isArray(mqr.questions)) {
    for (const q of mqr.questions) {
      if (!q || typeof q !== "object") continue;
      const qo = q as Record<string, unknown>;
      const qid = typeof qo.id === "string" ? qo.id : "";
      const cand = qo.answer ?? qo.answers ?? qo.selected ?? qo.selectedOption ?? qo.value;
      let val: string | null = null;
      if (typeof cand === "string") val = cand;
      else if (Array.isArray(cand)) {
        const f = cand.find((x) => typeof x === "string");
        if (typeof f === "string") val = f;
      }
      if (val && val.includes(CODEX_MORE_LABEL)) {
        if (qid === "team_select" || qid === "agent_select" || qid === "task_select") {
          (out.perQuestion as Record<string, boolean>)[qid] = true;
        }
      }
    }
  }
}

function collectAnswerStrings(node: unknown, out: string[]): void {
  if (node == null) return;
  if (typeof node === "string") {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectAnswerStrings(item, out);
    return;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    // Priority keys: answers / answer / value / selection
    for (const key of ["answers", "answer", "value", "selection", "selected"]) {
      if (key in obj) {
        collectAnswerStrings(obj[key], out);
        return;
      }
    }
    // Otherwise walk all values (defensive; questions[].answer style)
    for (const v of Object.values(obj)) collectAnswerStrings(v, out);
  }
}

// ── Question builder ─────────────────────────────────────────────────────────
//
// Codex `request_user_input` schema (从 codex 系统提示词里扒的官方定义)：
//
//   {
//     questions: [1..3 个],           顶层只能带 1~3 个 question
//     每个 question: {
//       id: string (snake_case, required),
//       header: string (≤ 12 chars, required),
//       question: string (required),  ← 注意字段名不是 prompt
//       options: [2..3 个],           每 question 只允许 2-3 个 option
//       每个 option: { label, description } (都 required)
//     }
//   }
//
// 客户端会自动追加"其他"选项作为自由输入兜底，我们不能自己塞。
// 选项超 3 个（比如 team/agent/task 列表长）→ 只留头 2 个 label，
// 用户想选剩下的就走"其他"手输 id/name。
//
// See docs/2026-08-05-codex-onboarding.md §7.5.3.

interface CodexOption {
  label: string;
  description: string;
}

interface CodexQuestion {
  id: string;       // snake_case 稳定标识
  header: string;   // ≤ 12 chars UI 标签
  question: string; // 展示给用户的完整问题
  options: CodexOption[];
}

/** 截断 header 到 ≤ 12 字符（中文按 1 字符算 —— codex 未明确，保守走字符数）。 */
function clampHeader(s: string): string {
  return s.length <= 12 ? s : s.slice(0, 12);
}

/**
 * 分页构建 options：把 entries 按 codex 的 3-slot 上限切成多页，非末页尾部
 * 追加一个 "更多..." 选项供用户翻页；末页无 MORE，直接列出剩余。
 *
 * - entries.length <= 3 && 单页 → 直接原样
 * - 中间页：前 2 real + MORE（3 项，客户端"其他"槽独立）
 * - 末页：剩余 2~3 real
 * - entries.length === 0：兜底 2 项占位（codex 要求 ≥ 2）
 * - entries.length === 1：真实项 + "跳过" 占位（codex 要求 ≥ 2）
 */
function buildOptions(
  entries: Array<{ label: string; description: string }>,
  pageIndex: number,
): CodexOption[] {
  if (entries.length === 0) {
    return [
      { label: "跳过", description: "本次不关联，直接开始对话" },
      { label: "重试", description: "重新拉取列表再选" },
    ];
  }
  if (entries.length === 1) {
    return [
      entries[0]!,
      { label: "跳过", description: "本次不关联，直接开始对话" },
    ];
  }

  const safePage = Math.max(0, pageIndex);
  const page = computeCodexPagination(entries.length, safePage);
  const slice = entries.slice(page.start, page.end);

  if (page.isLastPage) {
    return slice;
  }

  const remaining = page.total - page.end;
  const morePageNo = safePage + 2; // human-facing (1-based, next page)
  const moreOption: CodexOption = {
    label: CODEX_MORE_LABEL,
    description: `查看下一批候选（第 ${morePageNo}/${page.totalPages} 页，还剩 ${remaining} 个）`,
  };
  return [...slice, moreOption];
}

function pageSuffix(pageIndex: number, totalPages: number): string {
  return totalPages > 1 ? `（第 ${pageIndex + 1}/${totalPages} 页）` : "";
}

function buildQuestions(data: FormData): CodexQuestion[] {
  const { teams, stage, selectedTeamId, retry } = data;
  const retryHint = retry ? "（上次未识别，请重新选择）" : "";
  const teamPage = Math.max(0, data.teamPage ?? 0);
  const agentPage = Math.max(0, data.agentPage ?? 0);
  const taskPage = Math.max(0, data.taskPage ?? 0);

  if (stage === "asset_confirm") {
    return [{
      id: "asset_confirm",
      header: clampHeader("是否关联资产"),
      question: `本次对话是否要关联团队资产（Skill / Memory / Agent / Task / Knowledge）？${retryHint}`,
      options: [
        {
          label: ASSET_CONFIRM_YES,
          description: "接下来会请你选择 Team、Agent、Task，选完后每轮对话会自动注入相关资产。",
        },
        {
          label: ASSET_CONFIRM_NO,
          description: "本次会话跳过团队资产，直接开始对话。",
        },
      ],
    }];
  }

  if (stage === "team") {
    const entries = teams.map((t) => ({
      label: `${t.team_name} (${t.team_id.slice(-8)})`,
      description: `Team ID: ${t.team_id}${t.agents?.length ? `，含 ${t.agents.length} 个 Agent` : ""}`,
    }));
    const pageInfo = computeCodexPagination(entries.length, teamPage);
    return [{
      id: "team_select",
      header: clampHeader("选 Team"),
      question: `请选择本次会话所属的 Team${pageSuffix(teamPage, pageInfo.totalPages)}${retryHint}：`,
      options: buildOptions(entries, teamPage),
    }];
  }

  // stage in { "agent_select", "task_select", "agent_task" (legacy) }
  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return [];

  const questions: CodexQuestion[] = [];

  // Agent question — 新 stage "agent_select" 或 legacy "agent_task" 都渲染。
  if ((stage === "agent_select" || stage === "agent_task") && team.agents.length > 0) {
    const entries = team.agents.map((a) => ({
      label: `${a.agent_name} (${a.agent_id.slice(-8)})`,
      description: `Agent ID: ${a.agent_id}`,
    }));
    const pageInfo = computeCodexPagination(entries.length, agentPage);
    questions.push({
      id: "agent_select",
      header: clampHeader("选 Agent"),
      question: `请选择「${team.team_name}」下要使用的 Agent${pageSuffix(agentPage, pageInfo.totalPages)}${retryHint}：`,
      options: buildOptions(entries, agentPage),
    });
  }

  // Task question — 新 stage "task_select" 或 legacy "agent_task" 都渲染。
  if ((stage === "task_select" || stage === "agent_task") && team.tasks.length > 0) {
    const entries = team.tasks.map((t) => ({
      label: t.isDefault ? t.task_name : `${t.task_name} (${t.task_id.slice(-8)})`,
      description: t.isDefault
        ? "该 Agent 的默认任务（推荐）"
        : `Task ID: ${t.task_id}`,
    }));
    const pageInfo = computeCodexPagination(entries.length, taskPage);
    const opts = buildOptions(entries, taskPage);
    questions.push({
      id: "task_select",
      header: clampHeader("选 Task"),
      question: `请选择「${team.team_name}」下关联的任务${pageSuffix(taskPage, pageInfo.totalPages)}${retryHint}：`,
      options: opts,
    });
  }

  return questions;
}

// ── Form Builder ───────────────────────────────────────────────────────────────

/**
 * Build a Codex `request_user_input` fake form response.
 * Supports both SSE streaming (Responses API events) and non-streaming JSON.
 */
export function buildFormResponse(data: FormData): Response {
  const questions = buildQuestions(data);
  const argsJson = JSON.stringify({ questions });

  // `id` 与 `call_id` 是 OpenAI Responses 规范里两个独立字段：
  //   - id     ：function_call item 自身唯一标识，规范要求 `fc` 前缀
  //   - call_id：把 function_call 与后续 function_call_output 配对的关联键，
  //              规范允许自由格式。回读侧 (codexFormAnswersAsMessages /
  //              extractCodexMoreFlags) 用 call_id.startsWith(TOOLCALL_PREFIX)
  //              识别 session-init，所以 call_id 仍用 call_ 前缀。
  const ts = Date.now();
  const fcId = TOOLCALL_ID_PREFIX + ts;
  const callId = TOOLCALL_PREFIX + ts;
  const responseId = "resp_codex_session_init_" + ts;

  if (data.stream) {
    return buildStreamingResponse(responseId, fcId, callId, argsJson);
  }
  return buildNonStreamingResponse(responseId, fcId, callId, argsJson);
}

// ── Non-streaming ────────────────────────────────────────────────────────────

function buildNonStreamingResponse(
  responseId: string,
  fcId: string,
  callId: string,
  argsJson: string,
): Response {
  const body = {
    id: responseId,
    object: "response",
    status: "completed",
    output: [
      {
        type: "function_call",
        id: fcId,
        name: TOOL_NAME,
        arguments: argsJson,
        call_id: callId,
      },
    ],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Streaming (Responses API SSE) ────────────────────────────────────────────

function buildStreamingResponse(
  responseId: string,
  fcId: string,
  callId: string,
  argsJson: string,
): Response {
  const encoder = new TextEncoder();
  // 关键：Responses API 里每个 event 的 data JSON **必须**带 `type` 字段
  //（跟 SSE `event:` 头同名），否则 codex 客户端解析器读不到 event 类型，
  // 表现为 tool_call 没进客户端 UI（form 不弹）。对齐抓包底稿 §7.5.2/3 真实上游行为。
  const sse = (event: string, d: Record<string, unknown>) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...d })}\n\n`);

  const functionCallItem = {
    type: "function_call" as const,
    id: fcId,
    name: TOOL_NAME,
    arguments: argsJson,
    call_id: callId,
  };

  const responseObj = {
    id: responseId,
    object: "response",
    status: "completed",
    output: [functionCallItem],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };

  const stream = new ReadableStream({
    start(controller) {
      // response.created
      controller.enqueue(sse("response.created", {
        response: { ...responseObj, status: "in_progress", output: [] },
      }));

      // response.in_progress
      controller.enqueue(sse("response.in_progress", {
        response: { ...responseObj, status: "in_progress", output: [] },
      }));

      // response.output_item.added (function_call) —— arguments 先空字符串,
      // 通过 arguments.delta 流式生成 (对齐真实上游帧序列)
      controller.enqueue(sse("response.output_item.added", {
        output_index: 0,
        item: { ...functionCallItem, arguments: "" },
      }));

      // response.function_call_arguments.delta —— 关键：真实上游 event 携带
      // item_id 用于跟 output_item.added 里的 item.id 对齐；缺 item_id 客户端
      // 无法把 delta 挂回对应 tool call。item.id 现在是 fcId (fc_ 前缀)，
      // item_id 必须同源。
      controller.enqueue(sse("response.function_call_arguments.delta", {
        output_index: 0,
        item_id: fcId,
        delta: argsJson,
      }));

      // response.function_call_arguments.done
      controller.enqueue(sse("response.function_call_arguments.done", {
        output_index: 0,
        item_id: fcId,
        arguments: argsJson,
      }));

      // response.output_item.done (function_call complete)
      controller.enqueue(sse("response.output_item.done", {
        output_index: 0,
        item: functionCallItem,
      }));

      // response.completed
      controller.enqueue(sse("response.completed", {
        response: responseObj,
      }));

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
