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

// ── opencode tool-result 剥壳 ───────────────────────────────────────────────
//
// opencode CLI 的原生 `question` tool 收到用户选择后，把答案以纯文本形式回给
// model 作为 tool-result，格式为：
//   User has answered your questions: "问题描述..."="用户答案"[, "问题2"="答案2"]
//
// 这里的**问题描述里往往包含"跳过"、"不关联"等字样**（因为我们在 form 里让
// 用户看到"跳过"选项）。如果直接把整段 content 喂给 extractAgentOnly /
// extractTaskOnly，第一行 SKIP_RE.test 就会命中问题描述里的"跳过" →
// 误判为 BYPASS_MARKER，导致 agent_select / task_select 阶段永远走不通。
//
// 修复：在这些 extractor 入口先剥壳——只提取所有 `="..."` 右边的 answer 段
// 拼接后再做后续判断。非 opencode 场景（CB XML / codex 裸文本 / wb 直接
// answer）不含此包裹层，helper 返回 null，走原始 content 老路径。
//
// asset_confirm 场景不用这个 helper，因为 extractAssetConfirm 是"先找肯定
// 标记再找否定标记"的白名单式匹配，问题描述里的"跳过"字样天然无害。
//
// 匹配 `="value"` 中的 value——注意 value 里可能出现被 opencode 转义过的
// 内层引号，实测（2026-08-19）opencode 客户端遇到内层引号会输出转义后的
// `\"` 或直接透传全角引号 `"`，为最大兼容用 `[^"]*` 简易匹配即可（覆盖
// 我们 form.ts 里所有 label——纯 label 文本没有裸英文引号）。
function extractOpencodeAnswers(content: string): string | null {
  if (!content.includes("User has answered your questions:")) return null;
  const answers: string[] = [];
  const re = /"[^"]*"="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[1]) answers.push(m[1]);
  }
  return answers.length > 0 ? answers.join(" | ") : null;
}

/**
 * 从用户答复中提取 asset_confirm 选择。
 * 返回 true=是（关联资产），false=否（bypass），null=未识别。
 */
export function extractAssetConfirm(content: string): boolean | null {
  // XML parsing
  const xml = parseQuestionAnswerXml(content);
  const answer = xml?.teamAnswer ?? xml?.agentAnswer ?? xml?.taskAnswer ?? content;

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

  // opencode: 剥壳 tool-result 包裹，避免问题描述里的"跳过"字样触发误 SKIP。
  // 见 extractOpencodeAnswers 头部注释。
  const opencodeAnswer = extractOpencodeAnswers(content);
  if (opencodeAnswer !== null) content = opencodeAnswer;

  let teamText: string | null = null;

  // XML parsing: CodeBuddy <question_answer> in user message.
  const xml = parseQuestionAnswerXml(content);
  if (xml) {
    teamText = xml.teamAnswer ?? null;
  }

  // 匹配策略（team 选项 label 格式: "team名 (id尾8位)"）
  const hay = teamText ?? content;
  const trimmed = hay.trim();

  // 检测"本次不关联" / SKIP_RE → bypass。
  // (P1-4) 早期只对 XML 解析出的 teamText 判 SKIP_RE, 非 XML content 走不到;
  // 真 codex CLI 里 codexFormAnswersAsMessages 把 JSON 答案抽成裸 content
  // (如 "跳过"), 结果 SKIP_RE 永远不触发 → 走到普通 team 名匹配 → 未命中 →
  // 被上层 (init.ts pending_team_select) 当"未识别"计 attemptCount, 3 次才
  // maxRetries 强制 bypass。对齐 extractAgentOnly (line 293) /
  // extractTaskOnly (line 324) 的姿势: 在正式匹配前无条件测 SKIP_RE。
  if (SKIP_RE.test(trimmed) || trimmed.includes(SKIP_LABEL)) {
    return BYPASS_MARKER;
  }

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

  // opencode: 剥壳 tool-result 包裹（见 extractOpencodeAnswers 头部）。
  const opencodeAnswer = extractOpencodeAnswers(content);
  if (opencodeAnswer !== null) content = opencodeAnswer;

  let agentText: string | null = null;
  let taskText: string | null = null;

  // XML parsing: CodeBuddy <question_answer> in user message.
  const xml = parseQuestionAnswerXml(content);
  if (xml) {
    agentText = xml.agentAnswer ?? null;
    taskText = xml.taskAnswer ?? null;
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

// ── codex-only 单题提取器 ─────────────────────────────────────────────────────
//
// 2026-08-08 codex session-init 重构：拆分 pending_agent_task 为独立的
// pending_agent_select + pending_task_select 后，每一步都只提取一个字段。
// 复用 matchAgentInTeam / matchTaskInTeam 上面的模糊匹配（含 label/name/
// suffix/substring 兜底），保证 codex handler 传下来的 "AgentName (xxxxxxxx)"
// 之类原样 label 也能命中。
//
// CB 客户端老路径（一发同时问 agent+task）继续走 extractFromOptionText，不
// 触碰这两个新函数。

/**
 * 仅从纯文本 answer 里识别一个 agent_id（codex 单 agent_select stage）。
 *
 * 返回：
 *   - BYPASS_MARKER：用户显式表达"跳过/不关联"
 *   - agent_id：命中候选
 *   - null：未识别
 */
export function extractAgentOnly(
  content: string,
  cachedTeams: TeamOption[],
  selectedTeamId?: string,
): string | typeof BYPASS_MARKER | null {
  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  if (!team) return null;
  // opencode: 剥壳 tool-result 包裹（见 extractOpencodeAnswers 头部）。
  const opencodeAnswer = extractOpencodeAnswers(content);
  if (opencodeAnswer !== null) content = opencodeAnswer;
  const trimmed = content.trim();
  if (!trimmed) return null;
  if (SKIP_RE.test(trimmed) || trimmed.includes(SKIP_LABEL)) return BYPASS_MARKER;
  return matchAgentInTeam(trimmed, team);
}

/**
 * 仅从纯文本 answer 里识别一个 task_id（codex 单 task_select stage）。
 *
 * 返回：
 *   - BYPASS_MARKER：用户显式表达"跳过/不关联"（此处的"不关联任务"由 defaultTaskId
 *     虚拟条目命中 matchTaskInTeam 走返回 task_id 分支，而不会跑到 BYPASS 分支）
 *   - task_id：命中候选
 *   - null：未识别
 */
export function extractTaskOnly(
  content: string,
  cachedTeams: TeamOption[],
  selectedTeamId?: string,
): string | typeof BYPASS_MARKER | null {
  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  if (!team) return null;
  // opencode: 剥壳 tool-result 包裹（见 extractOpencodeAnswers 头部）。
  const opencodeAnswer = extractOpencodeAnswers(content);
  if (opencodeAnswer !== null) content = opencodeAnswer;
  const trimmed = content.trim();
  if (!trimmed) return null;
  // 先尝试匹配真实/虚拟 task 条目（虚拟条目由 fetchTeamsAndAgents 头部注入,
  // label="本次不关联任务"命中后返回的是 defaultTaskId，符合"跳过 task 但保
  // 留 agent"契约，不当作 BYPASS）。
  const matched = matchTaskInTeam(trimmed, team);
  if (matched) return matched;
  if (SKIP_RE.test(trimmed) || trimmed.includes(SKIP_LABEL)) return BYPASS_MARKER;
  return null;
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
