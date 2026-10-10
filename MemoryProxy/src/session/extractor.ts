/**
 * Identity extractor — picks agent + task selection from user reply.
 *
 * V3: Supports:
 *   1. ask_followup_question option text (user clicked a button) — matched by name
 *   2. Numeric selection ("agent: 1\ntask: 2")
 *   3. Raw ID input ("agent: agent_bug_fixer")
 *
 * The historical LLM-based extraction fallback was removed — when structured
 * parsing can't match, callers should bump the retry counter and bypass.
 */

import type { SessionInitData, AgentOption, TaskOption, TeamOption } from "./types.js";
import { PATH_SEP, SKIP_LABEL, MORE_LABEL } from "./form.js";

// ── Path A: Match from option text (ask_followup_question click result) ────────

// SKIP_RE（`/跳过|不关联|skip/i` 自由文本正则）已于 2026-09-21 删除：它历史上
// 作为"用户自由文本回复 → BYPASS"的兜底路径，但 team/agent/task 阶段的 form
// 现在**不再提供主动跳过按钮**（唯一入口是 asset_confirm 的 ASSET_CONFIRM_NO），
// 这条兜底既无正当业务场景又会误伤。删除后契约变成：extractor 只识别
// SKIP_LABEL 精确文本；匹配失败一律 return null → 上层 attemptCount ≥
// maxRetries 兜底。

/** Bypass 标记：用户选了"本次不关联"，整个 session-init 直接跳过。 */
export const BYPASS_MARKER = "__bypass__" as const;

/**
 * 分页"更多"标记：Claude Code 分页流里，用户点"更多 →"会触发 handler 把
 * agentPageIndex+1 并重发下一页 form。状态保持 pending_agent_task，不算 retry。
 */
export const MORE_MARKER = "__more__" as const;

/**
 * Parse CodeBuddy's `<question_answer>` XML that is generated when the user
 * clicks an option in an `ask_followup_question` form. This XML is sent back
 * as the next user message. Example:
 *
 *   <question_answer>
 *   <title>...</title>
 *   <questions>
 *   <question_item id="agent">
 *   <question>请选择本次会话使用的 Agent：</question>
 *   <answers>
 *   Bug Fixer — 自动定位并修复代码缺陷
 *   </answers>
 *   </question_item>
 *   <question_item id="task">...</question_item>
 *   </questions>
 *   </question_answer>
 *
 * The `id` echoes whatever we passed in the tool_call args (we use "agent"/"task"),
 * but the model may also use generic ids like "q1"/"q2", so we accept both.
 * Returns the raw answer text per slot, or null if no XML form is present.
 */
function parseQuestionAnswerXml(
  content: string,
): {
  teamAnswer?: string;
  agentAnswer?: string;
  taskAnswer?: string;
} | null {
  if (!content.includes("<question_answer") && !content.includes("<question_item")) {
    return null;
  }

  const result: { teamAnswer?: string; agentAnswer?: string; taskAnswer?: string } = {};
  const itemRe =
    /<question_item\s+id="([^"]+)"\s*>[\s\S]*?<answers>\s*([\s\S]*?)\s*<\/answers>/g;
  let m: RegExpExecArray | null;
  let index = 0;
  // 先扫描所有 question_item，判断总共有几个 question。
  // 轮1 form 只有 1 个 question（team），轮2 form 有 2 个（agent + task）。
  const allIds: string[] = [];
  const idRe = /<question_item\s+id="([^"]+)"\s*>/g;
  let idM: RegExpExecArray | null;
  while ((idM = idRe.exec(content)) !== null) {
    allIds.push(idM[1].trim().toLowerCase());
  }
  const isSingleQuestion = allIds.length === 1;

  while ((m = itemRe.exec(content)) !== null) {
    const id = m[1].trim().toLowerCase();
    const answer = m[2].trim();
    if (!answer) {
      index++;
      continue;
    }
    // 已知 id：team / agent / task；未知 id 走索引兜底
    if (id === "team") {
      result.teamAnswer = result.teamAnswer ?? answer;
    } else if (id === "agent") {
      result.agentAnswer = result.agentAnswer ?? answer;
    } else if (id === "task") {
      result.taskAnswer = result.taskAnswer ?? answer;
    } else if (id === "q1") {
      if (isSingleQuestion) {
        // 轮1 form 只有 1 个 question — q1 就是 team
        result.teamAnswer = result.teamAnswer ?? answer;
      } else {
        // 轮2 form 有 2 个 question — q1 是 agent
        result.agentAnswer = result.agentAnswer ?? answer;
      }
    } else if (id === "q2" && !isSingleQuestion) {
      result.taskAnswer = result.taskAnswer ?? answer;
    } else if (index === 0 && !result.teamAnswer && !result.agentAnswer) {
      // 兜底：第一个 question 且 id 未知，归到 team
      result.teamAnswer = answer;
    }
    index++;
  }

  return result.teamAnswer || result.agentAnswer || result.taskAnswer ? result : null;
}

/**
 * 轮1 提取：从用户答复中识别选定的 team_id。
 *
 * 解析策略按 agentSource 分叉：
 * - **CodeBuddy**: 用户选择在 `role: "user"` 消息中（`<question_answer>` XML 或纯文本），
 *   直接走 XML 解析 + substring fallback。不做 JSON 解析，避免误读 tool 空壳。
 * - **Claude Code**: 用户选择在 `role: "tool"` 消息中（`multi_question_result` JSON
 *   或 `AskUserQuestion` tool_result），走 JSON 解析 + substring fallback。
 *
 * @param agentSource  "codebuddy" | "claude-code"
 * @returns team_id，或 BYPASS_MARKER（用户选了"本次不关联"），或 null（未识别）
 */
export function extractTeamFromOptionText(
  content: string,
  cachedTeams: TeamOption[],
  agentSource: string = "codebuddy",
): string | null {
  if (cachedTeams.length === 0) return null;

  let teamText: string | null = null;

  // 1) JSON parsing: both CodeBuddy (multi_question_result in tool message) and
  //    Claude Code (AskUserQuestion tool_result / multi_question_result).
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null) {
      // dsh v0.2 ask_user_question tool_result:
      //   { answers: [ { id, selected: string[], custom? }, ... ] }
      // (dsh 源码 packages/interaction/tool-ask-user/src/index.ts:91-97 + 抓包实证 2026-09-29)
      // selected[] 是**选中的 option label 字符串数组**(见 dsh types.ts:58 注释)。
      // 与 CC 老 shape `{ answers: { "q": "label" } }` 结构不同,array 分支必须先判。
      if (Array.isArray(parsed.answers)) {
        for (const a of parsed.answers) {
          if (!a || typeof a !== "object") continue;
          const ao = a as Record<string, unknown>;
          // custom 优先(用户在 "Other" 里输入的自由文本,含 skip 判据),再看 selected[0]
          const cand = typeof ao.custom === "string" && ao.custom.trim()
            ? ao.custom.trim()
            : Array.isArray(ao.selected)
              ? ao.selected.find((x) => typeof x === "string" && x.trim())
              : undefined;
          if (typeof cand === "string" && cand.trim()) {
            teamText = cand.trim();
            break;
          }
        }
      }
      // AskUserQuestion tool_result (CC 老 shape): { answers: { "q": "label" } }
      if (!teamText && parsed.answers && typeof parsed.answers === "object" && !Array.isArray(parsed.answers)) {
        const answers = parsed.answers as Record<string, string>;
        for (const val of Object.values(answers)) {
          if (typeof val === "string" && val.trim()) {
            teamText = val.trim();
            break;
          }
        }
      }
      // multi_question_result envelope (both CodeBuddy and Claude Code)
      if (!teamText) {
        const mqr = (parsed.result ?? parsed) as Record<string, unknown> | undefined;
        if (mqr && mqr.type === "multi_question_result" && Array.isArray(mqr.questions)) {
          for (const q of mqr.questions) {
            if (!q || typeof q !== "object") continue;
            const qo = q as Record<string, unknown>;
            const cand = qo.answer ?? qo.answers ?? qo.selected ?? qo.selectedOption ?? qo.value;
            let val: string | null = null;
            if (typeof cand === "string") val = cand.trim() || null;
            else if (Array.isArray(cand)) {
              const f = cand.find((x) => typeof x === "string" && x.trim());
              if (typeof f === "string") val = f.trim();
            }
            if (val) { teamText = val; break; }
          }
        }
      }
    }
  } catch {
    /* not JSON — try XML / substring fallback */
  }

  // 2) XML parsing: CodeBuddy <question_answer> in user message.
  if (!teamText) {
    const xml = parseQuestionAnswerXml(content);
    if (xml) {
      teamText = xml.teamAnswer ?? null;
    }
  }

  // 检测"本次不关联"→ 直接 bypass（只识别 SKIP_LABEL 精确文本，SKIP_RE 自由
  // 文本兜底已删，见文件顶部说明）
  if (teamText && teamText.includes(SKIP_LABEL)) {
    return BYPASS_MARKER;
  }

  // 匹配策略（team 选项 label 格式: "team名 (id尾8位)"）：
  //   1. 精确匹配完整 label（含 id 后缀）
  //   2. 精确匹配纯 team_name
  //   3. 按 id 后缀匹配 "(xxxxxxxx)" 部分
  //   4. substring fallback（按名称长度降序）
  const hay = teamText ?? content;
  const trimmed = hay.trim();

  const exactFull = cachedTeams.find(
    (t) => `${t.team_name} (${t.team_id.slice(-8)})` === trimmed,
  );
  if (exactFull) return exactFull.team_id;

  const exactName = cachedTeams.find((t) => t.team_name === trimmed);
  if (exactName) return exactName.team_id;

  const suffixMatch = trimmed.match(/\((\w{8})\)$/);
  if (suffixMatch) {
    const exactSuffix = cachedTeams.find((t) => t.team_id.slice(-8) === suffixMatch[1]);
    if (exactSuffix) return exactSuffix.team_id;
  }

  const sorted = [...cachedTeams].sort((a, b) => b.team_name.length - a.team_name.length);
  for (const t of sorted) {
    if (hay.includes(t.team_name)) return t.team_id;
  }
  for (const t of cachedTeams) {
    if (hay.includes(t.team_id.slice(-8))) return t.team_id;
  }
  return null;
}

/**
 * 在指定 team 内匹配 agent。轮2 form 把 team 已经定死，没有跨 team 误匹配的可能。
 *
 * 匹配策略（agent 选项 label 格式: "agent名 (id尾8位)"）：
 *   1. 精确匹配完整 label（含 id 后缀）
 *   2. 精确匹配纯 agent_name
 *   3. 按 id 后缀匹配 "(xxxxxxxx)" 部分
 *   4. substring fallback（按 agent_name 长度倒序避免短名误匹配）
 */
function matchAgentInTeam(text: string, team: TeamOption): string | null {
  const trimmed = text.trim();

  const exactFull = team.agents.find(
    (a) => `${a.agent_name} (${a.agent_id.slice(-8)})` === trimmed,
  );
  if (exactFull) return exactFull.agent_id;

  const exactName = team.agents.find((a) => a.agent_name === trimmed);
  if (exactName) return exactName.agent_id;

  const suffixMatch = trimmed.match(/\((\w{8})\)$/);
  if (suffixMatch) {
    const exactSuffix = team.agents.find((a) => a.agent_id.slice(-8) === suffixMatch[1]);
    if (exactSuffix) return exactSuffix.agent_id;
  }

  const sorted = [...team.agents].sort((a, b) => b.agent_name.length - a.agent_name.length);
  for (const a of sorted) {
    if (text.includes(a.agent_name)) return a.agent_id;
  }
  for (const a of team.agents) {
    if (text.includes(a.agent_id.slice(-8))) return a.agent_id;
  }
  return null;
}

/**
 * 在指定 team 内匹配 task。task 选项 label 格式: "任务名 (id尾8位)"。
 *   - 先尝试精确匹配完整 label（含 id 后缀）
 *   - 再尝试仅匹配 task_name
 *   - substring fallback（按名称长度降序，优先长名）
 */
function matchTaskInTeam(
  text: string,
  team: TeamOption,
  _hintAgentId?: string,
): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();

  // 1) 精确匹配完整 label: "任务名 (xxxxxxxx)"
  const exactFull = team.tasks.find((t) => `${t.task_name} (${t.task_id.slice(-8)})` === trimmed);
  if (exactFull) return exactFull.task_id;

  // 2) 精确匹配纯 task_name（可能有多个同名，返回第一个）
  const exactName = team.tasks.find((t) => t.task_name === trimmed);
  if (exactName) return exactName.task_id;

  // 3) 按 id 后缀精确匹配 "(xxxxxxxx)" 部分
  const suffixMatch = trimmed.match(/\((\w{8})\)$/);
  if (suffixMatch) {
    const exactSuffix = team.tasks.find((t) => t.task_id.slice(-8) === suffixMatch[1]);
    if (exactSuffix) return exactSuffix.task_id;
  }

  // 4) substring fallback：按 task_name 长度降序
  const sorted = [...team.tasks].sort((a, b) => b.task_name.length - a.task_name.length);
  for (const t of sorted) {
    if (trimmed.includes(t.task_name)) return t.task_id;
  }

  // 5) 宽松匹配：trimmed 中任意 8 字符子串匹配 id 后缀
  for (const t of team.tasks) {
    if (trimmed.includes(t.task_id.slice(-8))) return t.task_id;
  }

  return undefined;
}

/** @deprecated 旧扁平结构，仅保留供老测试调用。 */
function matchAgent(text: string, agents: AgentOption[]): string | null {
  const exact = agents.find((a) => a.name === text);
  if (exact) return exact.id;
  const candidates = [...agents].sort((a, b) => b.name.length - a.name.length);
  for (const a of candidates) {
    if (text.includes(a.name)) return a.id;
  }
  return null;
}

/** @deprecated 旧扁平结构，仅保留供老测试调用。 */
function matchTask(text: string, tasks: TaskOption[]): string | undefined {
  const exact = tasks.find((t) => t.name === text);
  if (exact) return exact.id;
  const candidates = [...tasks].sort((a, b) => b.name.length - a.name.length);
  for (const t of candidates) {
    if (text.includes(t.name)) return t.id;
  }
  return undefined;
}

/**
 * 轮2 提取：从用户答复中识别 agent + task，**强制限定在已选定的 team 内**。
 * 跨 team 错配从协议层杜绝（轮1 form 已经把 team 定死）。
 *
 * 解析策略按 agentSource 分叉：
 * - **CodeBuddy**: 用户选择在 `role: "user"` 消息中，走 `<question_answer>` XML 解析
 *   + substring fallback。不做 JSON 解析，避免误读 tool 空壳。
 * - **Claude Code**: 用户选择在 `role: "tool"` 消息中（`multi_question_result` JSON
 *   或 `AskUserQuestion` tool_result），走 JSON 解析 + substring fallback。
 *
 * @param agentSource  "codebuddy" | "claude-code"
 * @returns `{ agent_id: BYPASS_MARKER }` 表示用户选了"本次不关联"。
 */
export function extractFromOptionText(
  content: string,
  cachedTeams: TeamOption[],
  selectedTeamId?: string,
  agentSource: string = "codebuddy",
): SessionInitData | null {
  // 必须有已选 team 才进入轮2 解析；否则视为非法状态。
  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  if (!team) return null;

  let agentText: string | null = null;
  let taskText: string | null = null;

  // 1) JSON parsing: both CodeBuddy (multi_question_result in tool message) and
  //    Claude Code (AskUserQuestion tool_result / multi_question_result).
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null) {
      // dsh v0.2 ask_user_question tool_result:
      //   { answers: [ { id, selected: string[], custom? }, ... ] }
      // 见 dsh 源码 packages/interaction/tool-ask-user/src/index.ts:91-97。
      // 按 id 分派:agent_select → agent,task_select → task;都塞不进时回退看
      // selected label 能否匹上 agent (向后兼容,防 dsh id 命名漂移)。
      if (!agentText && !taskText && Array.isArray(parsed.answers)) {
        for (const a of parsed.answers) {
          if (!a || typeof a !== "object") continue;
          const ao = a as Record<string, unknown>;
          const id = typeof ao.id === "string" ? ao.id.toLowerCase() : "";
          const cand = typeof ao.custom === "string" && ao.custom.trim()
            ? ao.custom.trim()
            : Array.isArray(ao.selected)
              ? ao.selected.find((x) => typeof x === "string" && x.trim())
              : undefined;
          if (typeof cand !== "string" || !cand.trim()) continue;
          const trimmed = cand.trim();
          // id 显式 "agent_select"/"task_select"(dsh form.ts buildAskUserQuestionArgs
          // 里塞的)—— 精确分派。也接受宽松命名。
          if (!agentText && (id.includes("agent") || matchAgentInTeam(trimmed, team))) {
            agentText = trimmed;
          } else if (!taskText && id.includes("task")) {
            taskText = trimmed;
          }
        }
      }
      // AskUserQuestion tool_result (CC 老 shape): { answers: { "q": "label" } }
      if (!agentText && !taskText && parsed.answers && typeof parsed.answers === "object" && !Array.isArray(parsed.answers)) {
        const answers = parsed.answers as Record<string, string>;
        for (const val of Object.values(answers)) {
          const trimmed = val.trim();
          if (!trimmed) continue;
          if (matchAgentInTeam(trimmed, team)) {
            agentText = trimmed;
            break;
          }
        }
      }
      // multi_question_result envelope (both CodeBuddy and Claude Code)
      if (!agentText && !taskText) {
        const mqr = (parsed.result ?? parsed) as Record<string, unknown> | undefined;
        if (mqr && mqr.type === "multi_question_result" && Array.isArray(mqr.questions)) {
          const pickAnswer = (q: Record<string, unknown>): string | null => {
            const cand = q.answer ?? q.answers ?? q.selected ?? q.selectedOption ?? q.value;
            if (cand == null) return null;
            if (typeof cand === "string") return cand.trim() || null;
            if (Array.isArray(cand)) {
              const first = cand.find((x) => typeof x === "string" && x.trim());
              return typeof first === "string" ? first.trim() : null;
            }
            return null;
          };
          for (const q of mqr.questions) {
            if (!q || typeof q !== "object") continue;
            const qo = q as Record<string, unknown>;
            const id = typeof qo.id === "string" ? qo.id.toLowerCase() : "";
            const ans = pickAnswer(qo);
            if (!ans) continue;
            if (id === "agent" && !agentText) agentText = ans;
            else if (id === "task" && !taskText) taskText = ans;
          }
        }
      }
    }
  } catch {
    /* not JSON — try XML / substring fallback */
  }

  // 2) XML parsing: CodeBuddy <question_answer> in user message.
  if (!agentText && !taskText) {
    const xml = parseQuestionAnswerXml(content);
    if (xml) {
      agentText = xml.agentAnswer ?? null;
      taskText = xml.taskAnswer ?? null;
    }
  }

  // 检测 Agent 选了"更多 →"→ 翻页（仅在已提取到 agentText 时判断，
  // 避免 content 中表单选项文本里的 label 误触发）
  if (agentText && agentText.includes(MORE_LABEL)) {
    return { agent_id: MORE_MARKER };
  }

  // 检测 Agent 选了"本次不关联"→ bypass（只识别 SKIP_LABEL 精确文本，SKIP_RE
  // 自由文本兜底已删，见文件顶部说明）
  if (agentText && agentText.includes(SKIP_LABEL)) {
    return { agent_id: BYPASS_MARKER };
  }

  // Resolve agent —— 严格只在 team.agents 内匹配
  let agentId: string | null = null;
  if (agentText) agentId = matchAgentInTeam(agentText, team);
  if (!agentId) agentId = matchAgentInTeam(content, team);
  if (!agentId) return null;

  // Resolve task —— 同 team 内匹配；SKIP_RE 自由文本兜底已删（见文件顶部说明），
  // 无条件调用 matchTaskInTeam；未命中即保持 taskId=undefined 走默认逻辑。
  let taskId: string | undefined;
  const taskHay = taskText ?? content;
  taskId = matchTaskInTeam(taskHay, team, agentId);

  return { agent_id: agentId, task_id: taskId };
}

// ── Path B: Structured Matching ────────────────────────────────────────────────

/** Extract agent_id and optional task from user reply (regex-based). */
export function extractStructured(content: string): SessionInitData | null {
  const agentMatch = content.match(/agent\s*[:：=]\s*(\S+)/i);
  if (!agentMatch) return null;

  const agent_id = agentMatch[1].trim();
  if (!agent_id) return null;

  let task_id: string | undefined;
  const taskMatch = content.match(/task\s*[:：=]\s*(\S+)/i);
  if (taskMatch && taskMatch[1] !== "0" && taskMatch[1].toLowerCase() !== "skip") {
    task_id = taskMatch[1].trim();
  }

  return { agent_id, task_id };
}

/**
 * Resolve user's agent selection from a possibly numeric / partial label.
 * 数字按所选 team 的 agents 1-based 取索引；字符串原样返回。
 */
export function resolveAgent(
  rawAgentId: string,
  cachedTeams: TeamOption[],
  selectedTeamId?: string,
): string {
  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  // 仅在 rawAgentId 是 **纯数字**（"1" / "2" 这种序号回复）时按 1-based 索引解析。
  // 严禁用 parseInt 容忍前缀数字 —— ULID 以 "01..." 开头，parseInt 会拿到 1，
  // 把所有真实 agent_id 错误地映射成 team.agents[0]（团队首个 agent）。
  if (team && /^\d+$/.test(rawAgentId)) {
    const num = parseInt(rawAgentId, 10);
    if (num > 0 && num <= team.agents.length) {
      return team.agents[num - 1].agent_id;
    }
  }
  return rawAgentId;
}

/**
 * Resolve user's task selection from a possibly numeric / raw value.
 * 数字按所选 team 内的 task 列表 1-based 取索引，agentHintId 优先；字符串原样返回。
 */
export function resolveTask(
  rawTaskId: string | undefined,
  cachedTeams: TeamOption[],
  agentHintId?: string,
  selectedTeamId?: string,
): string | undefined {
  if (!rawTaskId) return undefined;
  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  // 同 resolveAgent：只接受纯数字序号，避免 parseInt 容忍 "01KV..." 前缀的 "0" 误判。
  if (team && /^\d+$/.test(rawTaskId)) {
    const num = parseInt(rawTaskId, 10);
    if (num > 0 && num <= team.tasks.length) {
      return team.tasks[num - 1].task_id;
    }
  }
  return rawTaskId;
}

// ── Combined Interface ─────────────────────────────────────────────────────────

/**
 * Extract identity purely via the engineered structured parser. The historical
 * LLM-based `extractViaLLM` fallback was removed — when structured parsing
 * fails, callers must bump the retry counter and eventually bypass session
 * init rather than hand the guessing job to an LLM.
 */
export async function extractIdentity(
  content: string,
): Promise<SessionInitData | null> {
  return extractStructured(content);
}
