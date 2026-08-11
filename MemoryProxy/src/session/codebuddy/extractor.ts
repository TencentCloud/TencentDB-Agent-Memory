/**
 * CodeBuddy Session Init — Extractor.
 *
 * 解析用户从 `ask_followup_question` form 的回复。
 *
 * ── 为什么看上去像在解析 XML，但跨 team 多轮 form 也能用 ──
 *
 * 当前只解析 `<question_answer>` XML（CodeBuddy 旧格式）。
 * 实测中 CodeBuddy 实际回写格式是 `role: "tool"` 消息中的 `multi_question_result` JSON
 * （详见 cleaner.ts 头部注释中的抓包格式），但 extractor 的 substring 兜底匹配
 * 能在无关 user 消息文本中"碰巧"匹配到 team/agent/task 名，使得 session init 侥幸成功。
 * 这是 fragile 依赖，不是精确解析。如需可靠提取，需增加 JSON 解析路径。
 *
 * 不含任何 Claude Code 逻辑（不解析 JSON tool_result）。
 */

import type { SessionInitData, TeamOption } from "../types.js";
import { SKIP_LABEL, PATH_SEP, ASSET_CONFIRM_YES, ASSET_CONFIRM_NO } from "./form.js";

// ── Markers ────────────────────────────────────────────────────────────────────

const SKIP_RE = /跳过|不关联|skip/i;
export const BYPASS_MARKER = "__bypass__" as const;

// ── JSON 解析 helpers（CodeBuddy CLI AskUserQuestion 回写格式）──────────────
// CodeBuddy CLI 的 AskUserQuestion tool_result 与 Claude Code 同源，回写为
// `role: "tool"` 消息的 JSON：`{ answers: { "q": "label" } }` 或
// multi_question_result envelope：
//   { result: { type: "multi_question_result", questions: [{id, answer}], answers: {...} } }

/** 从 tool 消息 JSON 中提取所有答案（按出现顺序）。非 JSON 返回空数组。 */
function extractJsonAnswers(content: string): string[] {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "string") return [parsed.trim()].filter(Boolean);
    if (typeof parsed !== "object" || parsed === null) return [];
    const out: string[] = [];

    // AskUserQuestion: { answers: { "q": "label" } }
    const answers = parsed.answers as Record<string, unknown> | undefined;
    if (answers && typeof answers === "object") {
      for (const val of Object.values(answers)) {
        if (typeof val === "string" && val.trim()) out.push(val.trim());
      }
    }

    // multi_question_result envelope
    const mqr = (parsed.result ?? parsed) as Record<string, unknown> | undefined;
    if (mqr && mqr.type === "multi_question_result" && Array.isArray(mqr.questions)) {
      for (const q of mqr.questions) {
        if (!q || typeof q !== "object") continue;
        const qo = q as Record<string, unknown>;
        const cand = qo.answer ?? qo.answers ?? qo.selected ?? qo.selectedOption ?? qo.value;
        if (typeof cand === "string" && cand.trim()) out.push(cand.trim());
        else if (Array.isArray(cand)) {
          const f = cand.find((x) => typeof x === "string" && x.trim());
          if (typeof f === "string") out.push(f.trim());
        }
      }
      const mqrAnswers = mqr.answers as Record<string, unknown> | undefined;
      if (mqrAnswers && typeof mqrAnswers === "object") {
        for (const val of Object.values(mqrAnswers)) {
          if (typeof val === "string" && val.trim()) out.push(val.trim());
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 提取第一个答案（单 question 场景：asset_confirm / team 阶段）。 */
function extractFirstAnswer(content: string): string | null {
  const arr = extractJsonAnswers(content);
  if (arr.length > 0) return arr[0];

  // CodeBuddy 文本回写（实测格式）：
  //   " · 问题文案 → 答案"（可能多行，取第一个含 → 的行）
  const line = content.split("\n").map((l) => l.trim()).find((l) => l.includes("→"));
  if (line) {
    const idx = line.lastIndexOf("→");
    const ans = line.slice(idx + 1).trim();
    return ans || null;
  }
  return null;
}

/** 按 id 区分 agent / task 答案（agent_task 多 question 场景）。 */
function extractAgentTaskFromJson(content: string): { agentText: string | null; taskText: string | null } {
  let agentText: string | null = null;
  let taskText: string | null = null;
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("not object"); // 落入下方文本格式解析
    }

    // AskUserQuestion: { answers: { "q": "label" } } — 第一个=agent，第二个=task
    if (parsed.answers && typeof parsed.answers === "object") {
      const vals = Object.values(parsed.answers).filter(
        (v) => typeof v === "string" && v.trim().length > 0,
      ) as string[];
      if (vals[0]) agentText = vals[0].trim();
      if (vals[1]) taskText = vals[1].trim();
    }

    // multi_question_result envelope — 按 question id 区分
    const mqr = (parsed.result ?? parsed) as Record<string, unknown> | undefined;
    if (mqr && mqr.type === "multi_question_result" && Array.isArray(mqr.questions)) {
      for (const q of mqr.questions) {
        if (!q || typeof q !== "object") continue;
        const qo = q as Record<string, unknown>;
        const id = typeof qo.id === "string" ? qo.id.toLowerCase() : "";
        const cand = qo.answer ?? qo.answers ?? qo.selected ?? qo.selectedOption ?? qo.value;
        let val: string | null = null;
        if (typeof cand === "string") val = cand.trim() || null;
        else if (Array.isArray(cand)) {
          const f = cand.find((x) => typeof x === "string" && x.trim());
          if (typeof f === "string") val = f.trim();
        }
        if (!val) continue;
        if (id === "agent" && !agentText) agentText = val;
        else if (id === "task" && !taskText) taskText = val;
      }
    }
    if (agentText || taskText) return { agentText, taskText };
    throw new Error("no agent/task found"); // 落入下方文本格式解析
  } catch {
    // ── CodeBuddy 文本回写（实测格式，非 JSON）──────────────────────────
    //   " · 问题文案 → 答案\n · 问题文案 → 答案"
    // 按行取 "→" 后的答案：第一个=agent，第二个=task（与表单问题顺序一致）
    const answers: string[] = [];
    for (const line of content.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const idx = t.lastIndexOf("→");
      if (idx >= 0) {
        const ans = t.slice(idx + 1).trim();
        if (ans) answers.push(ans);
      }
    }
    if (answers.length >= 2) return { agentText: answers[0], taskText: answers[1] };
    if (answers.length === 1) return { agentText: answers[0], taskText: null };
    const raw = content.trim();
    return { agentText: raw || null, taskText: null };
  }
}

/**
 * 从用户答复中提取 asset_confirm 选择。
 * 返回 true=是（关联资产），false=否（bypass），null=未识别。
 */
export function extractAssetConfirm(content: string): boolean | null {
  // XML parsing (旧格式)
  const xml = parseQuestionAnswerXml(content);
  // JSON parsing（AskUserQuestion / multi_question_result 回写）
  const jsonAnswer = extractFirstAnswer(content);
  const answer = xml?.teamAnswer ?? xml?.agentAnswer ?? xml?.taskAnswer ?? jsonAnswer ?? content;

  if (answer.includes(ASSET_CONFIRM_YES) || /是.*关联|关联.*是|确认.*关联/i.test(answer)) {
    return true;
  }
  if (answer.includes(ASSET_CONFIRM_NO) || /否.*不关联|不关联.*否|本次不关联/i.test(answer)) {
    return false;
  }
  return null;
}

// ── XML 解析 ───────────────────────────────────────────────────────────────────

/**
 * Parse CodeBuddy's `<question_answer>` XML from user message.
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

  // 先扫描所有 question_item 判断总数（轮1: 1个, 轮2: 2个）
  const allIds: string[] = [];
  const idRe = /<question_item\s+id="([^"]+)"\s*>/g;
  let idM: RegExpExecArray | null;
  while ((idM = idRe.exec(content)) !== null) {
    allIds.push(idM[1].trim().toLowerCase());
  }
  const isSingleQuestion = allIds.length === 1;

  let m: RegExpExecArray | null;
  let index = 0;
  while ((m = itemRe.exec(content)) !== null) {
    const id = m[1].trim().toLowerCase();
    const answer = m[2].trim();
    if (!answer) { index++; continue; }

    if (id === "team") {
      result.teamAnswer = result.teamAnswer ?? answer;
    } else if (id === "agent") {
      result.agentAnswer = result.agentAnswer ?? answer;
    } else if (id === "task") {
      result.taskAnswer = result.taskAnswer ?? answer;
    } else if (id === "q1") {
      if (isSingleQuestion) {
        result.teamAnswer = result.teamAnswer ?? answer;
      } else {
        result.agentAnswer = result.agentAnswer ?? answer;
      }
    } else if (id === "q2" && !isSingleQuestion) {
      result.taskAnswer = result.taskAnswer ?? answer;
    } else if (index === 0 && !result.teamAnswer && !result.agentAnswer) {
      result.teamAnswer = answer;
    }
    index++;
  }

  return result.teamAnswer || result.agentAnswer || result.taskAnswer ? result : null;
}

// ── Team 匹配 ──────────────────────────────────────────────────────────────────

/**
 * 轮1 提取：从用户答复中识别选定的 team_id。
 * CodeBuddy: 用户选择在 `role: "user"` 消息中，走 `<question_answer>` XML 解析。
 */
export function extractTeamFromOptionText(
  content: string,
  cachedTeams: TeamOption[],
): string | null {
  if (cachedTeams.length === 0) return null;

  let teamText: string | null = null;

  // XML parsing: CodeBuddy <question_answer> in user message.
  const xml = parseQuestionAnswerXml(content);
  if (xml) {
    teamText = xml.teamAnswer ?? null;
  } else {
    // JSON parsing: AskUserQuestion tool_result（单 question，第一个答案即 team）
    teamText = extractFirstAnswer(content);
  }

  // 检测"本次不关联"→ bypass
  if (teamText && (teamText.includes(SKIP_LABEL) || SKIP_RE.test(teamText.trim()))) {
    return BYPASS_MARKER;
  }

  // 匹配策略（team 选项 label 格式: "team名 (id尾8位)"）
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

// ── Agent / Task 匹配 ─────────────────────────────────────────────────────────

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

function matchTaskInTeam(text: string, team: TeamOption): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();

  const exactFull = team.tasks.find((t) => `${t.task_name} (${t.task_id.slice(-8)})` === trimmed);
  if (exactFull) return exactFull.task_id;

  const exactName = team.tasks.find((t) => t.task_name === trimmed);
  if (exactName) return exactName.task_id;

  const suffixMatch = trimmed.match(/\((\w{8})\)$/);
  if (suffixMatch) {
    const exactSuffix = team.tasks.find((t) => t.task_id.slice(-8) === suffixMatch[1]);
    if (exactSuffix) return exactSuffix.task_id;
  }

  const sorted = [...team.tasks].sort((a, b) => b.task_name.length - a.task_name.length);
  for (const t of sorted) {
    if (trimmed.includes(t.task_name)) return t.task_id;
  }
  for (const t of team.tasks) {
    if (trimmed.includes(t.task_id.slice(-8))) return t.task_id;
  }
  return undefined;
}

/**
 * 轮2 提取：从用户答复中识别 agent + task，**强制限定在已选定的 team 内**。
 * CodeBuddy: 走 `<question_answer>` XML 解析。
 */
export function extractFromOptionText(
  content: string,
  cachedTeams: TeamOption[],
  selectedTeamId?: string,
): SessionInitData | null {
  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  if (!team) return null;

  let agentText: string | null = null;
  let taskText: string | null = null;

  // XML parsing: CodeBuddy <question_answer> in user message.
  const xml = parseQuestionAnswerXml(content);
  if (xml) {
    agentText = xml.agentAnswer ?? null;
    taskText = xml.taskAnswer ?? null;
  } else {
    // JSON parsing: AskUserQuestion tool_result（agent_task 多 question，按 id 区分）
    const jr = extractAgentTaskFromJson(content);
    agentText = jr.agentText;
    taskText = jr.taskText;
  }

  // 检测 Agent 选了"本次不关联"→ bypass
  if (agentText && (agentText.includes(SKIP_LABEL) || SKIP_RE.test(agentText.trim()))) {
    return { agent_id: BYPASS_MARKER };
  }

  // Resolve agent
  let agentId: string | null = null;
  if (agentText) agentId = matchAgentInTeam(agentText, team);
  if (!agentId) agentId = matchAgentInTeam(content, team);
  if (!agentId) return null;

  // Resolve task。defaultTaskId 兜底通过 fetchTeamsAndAgents 头部注入实现：
  // 用户选中"本次不关联任务"label 会 matchTaskInTeam 命中虚拟条目返回
  // defaultTaskId，无需在此单独处理。SKIP_RE 兜底放到 match 失败之后，避免
  // 虚拟条目的"不关联"文案误伤。
  let taskId: string | undefined;
  const taskHay = taskText ?? content;
  taskId = matchTaskInTeam(taskHay, team);
  if (!taskId && SKIP_RE.test(taskHay)) {
    taskId = undefined; // 显式手打"跳过"→ 保持 undefined（走 completeRegistration bypass）
  }

  return { agent_id: agentId, task_id: taskId };
}

// ── Structured / LLM fallback ──────────────────────────────────────────────────

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

// ── Resolvers ──────────────────────────────────────────────────────────────────

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
  if (team && /^\d+$/.test(rawAgentId)) {
    const num = parseInt(rawAgentId, 10);
    if (num > 0 && num <= team.agents.length) {
      return team.agents[num - 1].agent_id;
    }
  }
  return rawAgentId;
}

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
  if (team && /^\d+$/.test(rawTaskId)) {
    const num = parseInt(rawTaskId, 10);
    if (num > 0 && num <= team.tasks.length) {
      return team.tasks[num - 1].task_id;
    }
  }
  return rawTaskId;
}
