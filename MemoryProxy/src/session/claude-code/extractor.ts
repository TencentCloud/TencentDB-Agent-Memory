/**
 * Claude Code Session Init — Extractor.
 *
 * 解析用户从 `AskUserQuestion` form 的回复。
 * Claude Code 用户选择在 `role: "tool"` 消息中，格式为 JSON tool_result。
 *
 * 支持的回复格式：
 *   1. AskUserQuestion tool_result: `{ answers: { "q": "label" } }`
 *   2. multi_question_result envelope
 *   3. 纯文本 label（用户选择了某个选项后 CLI 返回的字符串）
 *
 * 不含任何 CodeBuddy XML 解析逻辑。
 */

import type { SessionInitData, TeamOption } from "../types.js";
import { SKIP_LABEL, MORE_LABEL, ASSET_CONFIRM_YES, ASSET_CONFIRM_NO } from "./form.js";

// ── Markers ────────────────────────────────────────────────────────────────────

const SKIP_RE = /跳过|不关联|skip/i;
export const BYPASS_MARKER = "__bypass__" as const;
export const MORE_MARKER = "__more__" as const;

/**
 * 从用户答复中提取 asset_confirm 选择。
 * 返回 true=是（关联资产），false=否（bypass），null=未识别。
 *
 * 格式兼容：
 *   1. 精准选项: "是，关联团队资产" / "否，本次不关联"
 *   2. Q&A 格式: "Your questions have been answered: \"Q?\"=\"A\"."
 *   3. "Chat about this" / 自由文本 → 降级返回 null（bypass）
 */
export function extractAssetConfirm(content: string): boolean | null {
  const answer = extractAnswerFromJson(content);
  if (!answer) return null;

  // 先检查是否是拒绝/跳过/自由文本（Chat about this / declined / rejected）
  // 增加中文"非回答"模式：用户可能直接输入了与问句无关的内容
  if (/declined to answer|doesn't want to proceed|tool use was rejected|clarify these questions|declined/i.test(answer)) {
    return null;
  }

  // Claude Code 返回格式可能包含完整问答上下文，如:
  // "Your questions have been answered: \"问题？\"=\"答案\"."
  // 提取最后一个 = 后面引号中的内容作为实际答案
  let answerOnly = answer;
  const eqMatch = answer.match(/="([^"]+)"[^"]*$/);
  if (eqMatch) {
    answerOnly = eqMatch[1];
  }

  // 安全阀：如果提取后超过 80 字符，大概率不是纯用户答案而是包含 Q&A 全文
  // 此时拒绝走 loose regex，避免把问题中的"是否要关联"误判为"是"
  // （只有精准匹配 ASSET_CONFIRM_YES / ASSET_CONFIRM_NO 可以通过）
  const allowLoosePattern = answerOnly.length <= 80;

  // 精准匹配：完整选项文本
  if (answerOnly.includes(ASSET_CONFIRM_YES)) {
    return true;
  }
  if (answerOnly.includes(ASSET_CONFIRM_NO)) {
    return false;
  }

  if (allowLoosePattern) {
    // 宽松"是"匹配：必须以"是"或"确认"开头，避免"是否"、"不是"等误匹配
    if (/^(?:是|确认)[，,\s]/i.test(answerOnly.trim())) {
      return true;
    }
    // 宽松"否"匹配
    if (/^(?:否|不[，,\s]|跳过|skip)/i.test(answerOnly.trim())) {
      return false;
    }
  }

  return null;
}

// ── JSON 解析 helpers ──────────────────────────────────────────────────────────

/**
 * 从 Claude Code tool_result JSON 中提取答案文本。
 * 支持格式：
 *   - `{ answers: { "q": "label" } }` (AskUserQuestion 标准)
 *   - `{ type: "multi_question_result", questions: [...] }`
 *   - 纯文本字符串（用户自由输入）
 */
function extractAnswerFromJson(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "string") return parsed.trim() || null;
    if (typeof parsed !== "object" || parsed === null) return null;

    // AskUserQuestion tool_result: { answers: { "q": "label" } }
    if (parsed.answers && typeof parsed.answers === "object") {
      const answers = parsed.answers as Record<string, string>;
      for (const val of Object.values(answers)) {
        if (typeof val === "string" && val.trim()) {
          return val.trim();
        }
      }
    }

    // multi_question_result envelope
    const mqr = (parsed.result ?? parsed) as Record<string, unknown> | undefined;
    if (mqr && mqr.type === "multi_question_result" && Array.isArray(mqr.questions)) {
      for (const q of mqr.questions) {
        if (!q || typeof q !== "object") continue;
        const qo = q as Record<string, unknown>;
        const cand = qo.answer ?? qo.answers ?? qo.selected ?? qo.selectedOption ?? qo.value;
        if (typeof cand === "string" && cand.trim()) return cand.trim();
        if (Array.isArray(cand)) {
          const f = cand.find((x) => typeof x === "string" && x.trim());
          if (typeof f === "string") return f.trim();
        }
      }
    }

    return null;
  } catch {
    // Not JSON — Claude Code tool_result 常常是拼串格式：
    //   Your questions have been answered: "<question>"="<answer>".
    // 只取 ="..." 里的 answer；这样问题文案里出现的 "跳过 / 可跳过"
    // 等词不会污染下游 SKIP_RE 匹配（回归 session1.json Bug）。
    const eq = content.match(/="([^"]+)"[^"]*$/);
    if (eq) return eq[1].trim() || null;
    return content.trim() || null;
  }
}

/**
 * 从 JSON 中提取 agent 和 task 答案（轮2 多 question 场景）。
 */
function extractAgentTaskFromJson(content: string): { agentText: string | null; taskText: string | null } {
  let agentText: string | null = null;
  let taskText: string | null = null;

  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) {
      const raw = content.trim();
      const eq = raw.match(/="([^"]+)"[^"]*$/);
      return { agentText: (eq ? eq[1].trim() : raw) || null, taskText: null };
    }

    // AskUserQuestion: { answers: { "q": "label" } }
    if (parsed.answers && typeof parsed.answers === "object") {
      const answers = parsed.answers as Record<string, string>;
      for (const val of Object.values(answers)) {
        if (typeof val === "string" && val.trim()) {
          // CC form 轮2 只有 1 个 question (agent)，第一个非空答案就是 agent
          if (!agentText) agentText = val.trim();
          break;
        }
      }
    }

    // multi_question_result envelope
    if (!agentText && !taskText) {
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
    }
  } catch {
    // Not JSON — 兼容 Claude Code 拼串格式 `…"question"="answer".`
    const raw = content.trim();
    const eq = raw.match(/="([^"]+)"[^"]*$/);
    agentText = (eq ? eq[1].trim() : raw) || null;
  }

  return { agentText, taskText };
}

// ── Team 匹配 ──────────────────────────────────────────────────────────────────

/**
 * 轮1 提取：从用户答复中识别选定的 team_id。
 * Claude Code: 用户选择在 `role: "tool"` 消息中，走 JSON 解析。
 *
 * 返回值（对齐 extractTaskFromOptionText 三档姿势）：
 *   - team_id string：命中真实 team
 *   - MORE_MARKER：用户点了 "更多 →"，调用方翻页（team 分页 2026-09-03 新增）
 *   - BYPASS_MARKER：用户选 SKIP / declined
 *   - null：未识别
 */
export function extractTeamFromOptionText(
  content: string,
  cachedTeams: TeamOption[],
): string | typeof MORE_MARKER | typeof BYPASS_MARKER | null {
  if (cachedTeams.length === 0) return null;

  // 先检查是否是拒绝/跳过（Chat about this / declined）
  if (/declined to answer|doesn't want to proceed|tool use was rejected|clarify these questions/i.test(content)) {
    return null;
  }

  const teamText = extractAnswerFromJson(content);

  // 检测"本次不关联"→ bypass
  if (teamText && (teamText.includes(SKIP_LABEL) || SKIP_RE.test(teamText.trim()))) {
    return BYPASS_MARKER;
  }

  // 检测 "更多 →" → 翻页 (与 extractFromOptionText / extractTaskFromOptionText 一致)
  if (teamText && teamText.includes(MORE_LABEL)) {
    return MORE_MARKER;
  }

  // 匹配策略
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
 * task_select 阶段提取：只解析 answers 里的 label 而非 tool_result 全文。
 * 这里不再复用 extractFromOptionText 的旧路径 —— 那条路径把 tool_result 原文
 * 当 fallback 传给 matchTaskInTeam，会因问题文案（"…（可跳过）："）里包含
 * "跳过"而把用户明确选中的 task 误判成 bypass（历史 Bug）。
 *
 * 返回值：
 *   - task_id string：命中；
 *   - MORE_MARKER：用户点了 "更多 →"，调用方翻页；
 *   - BYPASS_MARKER：declined / 空答复 / 兼容旧表单的显式跳过；
 *   - null：identify 得到答案但匹配不到 team.tasks（调用方按未识别 → bypass 处理）。
 *
 * defaultTaskId 兜底关联通过 fetchTeamsAndAgents 头部注入实现 —— 用户选"本次
 * 不关联任务" label 时走 matchTaskInTeam 命中虚拟条目、返回 defaultTaskId，无
 * 需在此单独分支。
 */
export function extractTaskFromOptionText(
  content: string,
  team: import("../types.js").TeamOption | undefined,
): string | typeof MORE_MARKER | typeof BYPASS_MARKER | null {
  // declined / rejected → bypass（与其它阶段一致）
  if (/declined to answer|doesn't want to proceed|tool use was rejected|clarify these questions/i.test(content)) {
    return BYPASS_MARKER;
  }
  if (!team) return BYPASS_MARKER;

  const answer = extractAnswerFromJson(content);
  if (!answer) return BYPASS_MARKER;

  // 翻页
  if (answer.includes(MORE_LABEL)) return MORE_MARKER;

  // 兼容旧表单：用户手打 "跳过 / skip / 不关联" → 显式 bypass。注意：defaultTaskId
  // 虚拟条目的 label 是"暂时跳过"，SKIP_RE 会命中，所以先尝试正常匹配
  // 再走 bypass。
  const taskId = matchTaskInTeam(answer, team);
  if (taskId) return taskId;

  if (SKIP_RE.test(answer.trim())) {
    return BYPASS_MARKER;
  }

  return null;
}

/**
 * 轮2 提取：从用户答复中识别 agent + task。
 * Claude Code: 走 JSON 解析。仅在已选定的 team 内匹配。
 */
export function extractFromOptionText(
  content: string,
  cachedTeams: TeamOption[],
  selectedTeamId?: string,
): SessionInitData | null {
  // 先检查是否是拒绝/跳过（Chat about this / declined）
  if (/declined to answer|doesn't want to proceed|tool use was rejected|clarify these questions/i.test(content)) {
    return null;
  }

  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  if (!team) return null;

  const { agentText, taskText } = extractAgentTaskFromJson(content);

  // 检测 "更多 →" → 翻页
  if (agentText && agentText.includes(MORE_LABEL)) {
    return { agent_id: MORE_MARKER };
  }

  // 检测 "本次不关联" → bypass
  if (agentText && (agentText.includes(SKIP_LABEL) || SKIP_RE.test(agentText.trim()))) {
    return { agent_id: BYPASS_MARKER };
  }

  // Resolve agent
  let agentId: string | null = null;
  if (agentText) agentId = matchAgentInTeam(agentText, team);
  if (!agentId) agentId = matchAgentInTeam(content, team);
  if (!agentId) return null;

  // Resolve task
  let taskId: string | undefined;
  const taskHay = taskText ?? content;
  if (!SKIP_RE.test(taskHay)) {
    taskId = matchTaskInTeam(taskHay, team);
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
