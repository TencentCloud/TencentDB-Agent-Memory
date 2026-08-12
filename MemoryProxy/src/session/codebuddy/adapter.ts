/**
 * CodeBuddy Protocol Adapter — stable internal question model + typed result parsing.
 *
 * 946-B 目标（docs/946spec.md §18）：
 *   - 内部使用稳定 question id（InternalQuestion.id），显示 label 不作为 canonical 标识；
 *   - 结果解析返回类型化 ParsedFormResult，不依赖 Object.values() 顺序 / "第一个=agent 第二个=task" /
 *     显示 label 全局唯一 等脆弱假设；
 *   - 外部协议（CodeBuddy CLI AskUserQuestion / IDE）无法回传稳定 id 时，
 *     通过 header（稳定常量）+ 问题文本关键词做 server-side 映射。
 */

export const QUESTION_IDS = {
  assetConfirm: "asset_confirm",
  team: "team",
  agent: "agent",
  task: "task",
} as const;

export type QuestionId = (typeof QUESTION_IDS)[keyof typeof QUESTION_IDS];

/** 稳定内部问题模型（946-B §18.1）。显示 label 只在 wire 层存在，不作为标识。 */
export interface InternalQuestion {
  id: QuestionId;
  prompt: string;
  header: string;
  options: Array<{ value: string; label: string; description?: string }>;
  multiSelect?: boolean;
}

/**
 * 类型化解析结果（946-B §18.3）。
 * 客户端必须能区分：成功 / 取消 / 畸形。
 */
export type ParsedFormResult =
  | {
      kind: "recognized";
      /** key = 稳定 question id（asset_confirm | team | agent | task）。 */
      answers: Record<string, string[]>;
    }
  | {
      kind: "cancelled";
    }
  | {
      kind: "malformed";
      reason: string;
    };

/** 用于把 stable id → header 常量（form.ts 中的显示文案）。 */
export const HEADER_BY_QUESTION_ID: Record<QuestionId, string> = {
  asset_confirm: "关联资产",
  team: "Team",
  agent: "Agent",
  task: "Task",
};

/** 问题文本关键词 → question id 兜底（外部协议不携带 header/id 时用）。 */
const QUESTION_TEXT_KEYWORDS: Array<{ id: QuestionId; keywords: string[] }> = [
  { id: "asset_confirm", keywords: ["是否关联团队资产", "关联团队资产"] },
  { id: "team", keywords: ["选择 Team", "所属的 Team"] },
  { id: "agent", keywords: ["使用的 Agent", "要使用的 Agent", "下要使用的 Agent"] },
  { id: "task", keywords: ["关联的任务", "选择「", "下关联的任务"] },
];

/**
 * 从外部协议单个 question 对象中提取稳定 id。
 * 优先级：显式 id 字段 → header（稳定常量）→ 问题文本关键词。
 * 返回 undefined 表示无法识别该 question 的语义身份。
 */
export function resolveQuestionId(raw: unknown): QuestionId | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const q = raw as Record<string, unknown>;

  // 1) 显式 id（multi_question_result 回写通常带 id，如 "team"/"agent"/"task"）
  if (typeof q.id === "string") {
    const id = q.id.trim().toLowerCase();
    if (id === "asset_confirm" || id === "assetconfirm") return "asset_confirm";
    if (id === "team") return "team";
    if (id === "agent") return "agent";
    if (id === "task") return "task";
  }

  // 2) header（form.ts 构建时是稳定常量）
  if (typeof q.header === "string") {
    const header = q.header.trim();
    for (const [id, h] of Object.entries(HEADER_BY_QUESTION_ID)) {
      if (header === h) return id as QuestionId;
    }
  }

  // 3) 问题文本关键词
  const text = [q.question, q.prompt, q.title, q.text]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  if (text) {
    for (const { id, keywords } of QUESTION_TEXT_KEYWORDS) {
      if (keywords.some((k) => text.includes(k))) return id;
    }
  }

  return undefined;
}

/** 从单个 question 对象提取答案（string 或 string[]）。 */
function extractAnswerValue(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") return [raw.trim()].filter(Boolean);
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const v of raw) {
      if (typeof v === "string" && v.trim()) out.push(v.trim());
    }
    return out.length > 0 ? out : null;
  }
  if (typeof raw === "object") {
    // { label: string } 或 { value: string }
    const o = raw as Record<string, unknown>;
    const cand = typeof o.label === "string" ? o.label : typeof o.value === "string" ? o.value : null;
    if (cand && cand.trim()) return [cand.trim()];
  }
  return null;
}

/**
 * 解析 CodeBuddy tool 消息 JSON 为类型化结果。
 *
 * 支持的输入形态：
 *   1. AskUserQuestion 回写：{ answers: { "q": "label" } }（无显式 id）
 *   2. multi_question_result envelope：
 *      { result: { type: "multi_question_result", questions: [{id, answer|answers|selected}], answers: {...} } }
 *
 * 本实现**不依赖 Object.values() 顺序**：
 *   - answers 对象中的每个 key 都尝试解析为稳定 id（无法解析的丢弃）；
 *   - 若 answers 无 key（如 { "q": ... }），回退到 mqr.questions 数组中的显式 id / header / 文本。
 */
export function parseFormResult(content: string): ParsedFormResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { kind: "malformed", reason: "non-json" };
  }

  if (typeof parsed === "string") {
    // 纯文本答案 → 无法归一到具体 question id（无 header/文本上下文）
    return { kind: "recognized", answers: {} };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed", reason: "not-an-object" };
  }

  const root = parsed as Record<string, unknown>;
  const result = (root.result && typeof root.result === "object" ? root.result : root) as Record<string, unknown>;
  const answers: Record<string, string[]> = {};

  // ── multi_question_result envelope：questions 数组带显式 id/header ──
  if (result.type === "multi_question_result" && Array.isArray(result.questions)) {
    for (const rawQ of result.questions) {
      if (!rawQ || typeof rawQ !== "object") continue;
      const q = rawQ as Record<string, unknown>;
      const qid = resolveQuestionId(q);
      if (!qid) continue;
      const cand = extractAnswerValue(q.answer ?? q.answers ?? q.selected ?? q.selectedOption ?? q.value);
      if (cand) answers[qid] = cand;
    }
    // envelope 级 answers 兜底：{ answers: { "team": "..." } }
    const envAnswers = result.answers;
    if (envAnswers && typeof envAnswers === "object") {
      for (const [key, val] of Object.entries(envAnswers as Record<string, unknown>)) {
        const qid = resolveQuestionId({ id: key }) ?? resolveQuestionId({ header: key });
        const cand = extractAnswerValue(val);
        if (qid && cand) answers[qid] = cand;
      }
    }
  }

  // ── AskUserQuestion 回写：{ answers: { "q": "label" } }（key 无语义）──────
  // 仅在 envelope 路径未产出任何结果时兜底：保留顺序语义的"最后一问"优先，
  // 但**不**把第一个值硬编码为 agent（由调用方结合 form 上下文决定）。
  if (Object.keys(answers).length === 0 && root.answers && typeof root.answers === "object") {
    for (const val of Object.values(root.answers as Record<string, unknown>)) {
      const cand = extractAnswerValue(val);
      if (cand) {
        answers["_ordered"] = cand;
        break;
      }
    }
  }

  // ── cancelled 判定 ──
  // 显式 status=cancelled。
  if (typeof root.status === "string" && root.status.toLowerCase() === "cancelled") {
    return { kind: "cancelled" };
  }
  // multi_question_result 空壳中间态：questions 全部无答案（用户还没点）。
  // 注意：questions 带答案但 id 无法解析 ≠ 空壳，仍是 recognized（answers 为空由调用方处理）。
  const shell = (result.type === "multi_question_result" && Array.isArray(result.questions))
    && !result.questions.some((q) => typeof q === "object" && q !== null && hasAnyAnswer(q));
  if (Object.keys(answers).length === 0 && shell) {
    return { kind: "cancelled" };
  }

  return { kind: "recognized", answers };
}

/** 判断 question 对象是否携带任何可解析答案字段。 */
function hasAnyAnswer(q: Record<string, unknown>): boolean {
  const cand = q.answer ?? q.answers ?? q.selected ?? q.selectedOption ?? q.value;
  if (Array.isArray(cand)) return cand.length > 0;
  if (cand === undefined || cand === null) return false;
  if (typeof cand === "string") return cand.trim().length > 0;
  return true;
}
