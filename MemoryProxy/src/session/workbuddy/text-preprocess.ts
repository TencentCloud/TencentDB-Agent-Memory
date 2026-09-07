/**
 * WorkBuddy Text Mode — 输入预处理器。
 *
 * ── 背景 ──────────────────────────────────────────────────────────────────
 *
 * 新版 WorkBuddy 官方 tools 集合里拿掉了 `AskUserQuestion`（抓包实证 tools
 * 只有 20 个），继续发 tool_calls SSE 客户端不认识 → 卡死 pending。CP1 探测
 * 到 `capabilities.askUserQuestion === false`，CP2 已渲染成纯文字，本模块
 * 负责**下一轮用户回复**的翻译：把裸文本翻译成 CB 状态机 extractor 能识
 * 别的形态。
 *
 * ── 设计思路（复用 CB 既有能力） ──────────────────────────────────────
 *
 * CB extractor 早就有强大的 substring 匹配 + SKIP_RE + short-id 兜底逻辑
 * （见 codebuddy/extractor.ts）。文字模式的用户输入形态 → CB 能识别的翻译：
 *
 *   | 用户输入               | translate 结果                          |
 *   |------------------------|-----------------------------------------|
 *   | "2" (数字)             | 全表第 2 项的 team_name/agent_name/... |
 *   | "team B" (名字/前缀)   | 原样透传（CB substring 命中）            |
 *   | "abc12345" (short-id)  | 原样透传（CB short-id 后缀命中）         |
 *   | "next" / "下一页"      | "更多 →"（触发既有 WB MORE 拦截）        |
 *   | "prev" / "上一页"      | 特殊 action = "paginate-prev"，需短路   |
 *   | "skip" / "跳过"        | 原样透传（CB SKIP_RE 命中）              |
 *   | "是" / "否"            | 原样透传（asset_confirm 分支识别）       |
 *   | 其他                   | 原样透传（CB extractor 走 retry 兜底）   |
 *
 * ── 数字寻址：全表 vs 当前页 ────────────────────────────────────────
 *
 * 用户输入的数字（"1", "14" 等）按**全表 1-based 序号**寻址，而不是当前
 * 页内的相对序号。这跟渲染层 (`text-form.ts renderOptionList`) 里
 * `absoluteIdx = offset + i + 1` 输出的绝对序号完全对齐——用户视觉上看
 * 到的编号就是全表位置，无论翻到第几页，输 "14" 都精确指第 14 项。
 *
 * 越界：数字 > 全表长度才算越界 → passthrough；这时会走 CB extractor 的
 * retry / bypass 兜底。数字在全表内但不在当前页范围内（例如用户第 1 页
 * 直接输 "14"，第 14 项在第 2 页），照样翻译成第 14 项的 name。
 *
 * ── 零影响保证 ────────────────────────────────────────────────────────
 *
 * 本模块**没有任何全局副作用**——是纯函数。调用方（codebuddy/init.ts）用
 * `capabilities?.askUserQuestion === false` 严格 gate，只有新版 WorkBuddy
 * 无 AskUserQuestion tool 的请求才会走进来。其他所有 client 一律不进入。
 */

import type { TeamOption, AgentInTeam, TaskInTeam } from "../types.js";
import type { FormStage } from "./form.js";
import { MORE_LABEL as WB_MORE_LABEL, SKIP_LABEL as WB_SKIP_LABEL } from "./form.js";
import { TEXT_PAGE_SIZE } from "./text-pagination.js";
import { extractUserQueryText } from "../../common/user-query-extractor.js";

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * 预处理器决策。
 *
 * - `translate`  → 用 `translated` 覆盖 messages 尾部最后一条 user 消息内容，
 *                  然后**放行**给 CB 状态机继续跑（走 extractor 老路径）。
 * - `paginate-next` / `paginate-prev` → **短路**，直接把
 *                     state.codexPageIndex[对应 stage] 改成 newPageIndex 后
 *                     重渲染同 stage 的 form。不进 extractor，不消耗
 *                     attemptCount，也不推进 stage。
 * - `passthrough` → 什么都不做，用户原文本直接给 extractor（例如"skip / 团队 A /
 *                   team-abc12345"这些 extractor 已经能识别的形态）。
 */
export type PreprocessAction = "translate" | "paginate-next" | "paginate-prev" | "passthrough";

export interface PreprocessResult {
  action: PreprocessAction;
  /** action=translate 时的替换后文本；其他情况为 undefined。 */
  translated?: string;
  /** action=paginate-* 时的新页码（已裁到有效范围）；其他情况为 undefined。 */
  newPageIndex?: number;
  /**
   * 只用于日志和调试，说明预处理走了哪条分支。
   */
  reason: string;
}

/**
 * 预处理器需要的上下文：teams 全量列表、当前 stage、当前 stage 的分页信息、
 * 已选 team/agent id（用于筛出 agent/task 候选）。
 */
export interface PreprocessOptions {
  stage: FormStage;
  teams: readonly TeamOption[];
  selectedTeamId?: string;
  selectedAgentId?: string;
  /** 当前 stage 的页码（0-based）。 */
  currentPage: number;
  /** 页大小。默认走 TEXT_PAGE_SIZE。 */
  pageSize?: number;
}

// ── 关键字正则 ─────────────────────────────────────────────────────────────

/** next / 下一页 / 下页 / 下一步 —— 触发 MORE 翻页。 */
const NEXT_RE = /^\s*(next|下一?页|下一?步|n)\s*$/i;

/** prev / 上一页 / 上页 / 上一步 —— 触发 paginate-prev。 */
const PREV_RE = /^\s*(prev|previous|上一?页|上一?步|p)\s*$/i;

/** 纯数字 —— 需要根据当前页切片查表翻译成对应 label。 */
const DIGIT_RE = /^\s*(\d+)\s*$/;

/** yes / y / 是 —— 仅在 asset_confirm 阶段翻译成 ASSET_CONFIRM_YES label。 */
const YES_RE = /^\s*(yes|y|是)\s*$/i;

/** no / n / 否 —— 仅在 asset_confirm 阶段翻译成 ASSET_CONFIRM_NO label。 */
const NO_RE = /^\s*(no|n|否)\s*$/i;

// ── 主函数 ─────────────────────────────────────────────────────────────────

/**
 * 预处理用户在文字模式下的裸文本回复。
 *
 * 只有 `capabilities?.askUserQuestion === false` 的 WorkBuddy 请求会调用本
 * 函数（gate 在 codebuddy/init.ts 入口）。**其他所有 client 完全不进入**。
 *
 * ── 匹配优先级 ────────────────────────────────────────────────────────
 *
 *   1. prev  → action="paginate-prev"（页码 -1，clamp 到 0）
 *   2. next  → action="paginate-next"（页码 +1，clamp 到 totalPages-1）
 *   3. 数字  → 从**全表**取第 N 项，翻译成 team_name/agent_name/task_name
 *              （或 asset_confirm 的 "是/否" 具体 label）。全表越界才
 *              passthrough；跨页数字仍能命中。
 *   4. 其他  → passthrough（CB extractor 走 substring / SKIP_RE 兜底）
 *
 * 注意：**名字/short-id 匹配交给 CB extractor**（它已经做得很好），我们只
 * 处理"CB extractor 缺失的能力"（数字翻页/页级数字/prev/next）。
 */
export function preprocessTextModeInput(
  rawText: string,
  options: PreprocessOptions,
): PreprocessResult {
  // 剥离 WorkBuddy 客户端可能包裹的 <system-reminder> / <user_query> /
  // <additional_data> / <craft_mode> 等系统 XML wrapper，只保留用户真实键入。
  // 若原文没有这些包裹（例如老客户端或纯净输入），extractUserQueryText 会原样返回。
  const cleaned = extractUserQueryText(rawText ?? "");
  const text = cleaned.trim();
  if (!text) {
    return { action: "passthrough", reason: "empty-input" };
  }

  const pageSize = options.pageSize ?? TEXT_PAGE_SIZE;
  const totalItems = getTotalItemsForStage(options);
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

  // ── 0. yes/no（仅 asset_confirm 阶段）→ 翻译成精确 label ──────────────
  // 必须放在 next/prev 之前：`n` 同时命中 NEXT_RE 和 NO_RE，asset_confirm 阶段
  // 语义上 `n` 应该是 "no" 而不是 "next"（asset_confirm 也不需要翻页）。
  // 其他阶段的 yes/no 让 passthrough 走 extractor（extractor 目前不认，会走
  // retry 兜底，行为不变）。
  if (options.stage === "asset_confirm") {
    if (YES_RE.test(text)) {
      return {
        action: "translate",
        translated: "是，关联团队资产",
        reason: `yes-keyword → "是，关联团队资产"`,
      };
    }
    if (NO_RE.test(text)) {
      return {
        action: "translate",
        translated: "否，本次不关联",
        reason: `no-keyword → "否，本次不关联"`,
      };
    }
  }

  // ── 1. prev（上一页）──────────────────────────────────────────────────
  if (PREV_RE.test(text)) {
    const nextPage = Math.max(0, options.currentPage - 1);
    return {
      action: "paginate-prev",
      newPageIndex: nextPage,
      reason: `prev-keyword: ${options.currentPage} → ${nextPage}`,
    };
  }

  // ── 2. next（下一页）→ paginate-next 短路 ─────────────────────────────
  if (NEXT_RE.test(text)) {
    const nextPage = Math.min(totalPages - 1, options.currentPage + 1);
    return {
      action: "paginate-next",
      newPageIndex: nextPage,
      reason: `next-keyword: ${options.currentPage} → ${nextPage} (total=${totalPages})`,
    };
  }

  // ── 3. 数字 → 查当前页第 N 项 ──────────────────────────────────────
  const digitMatch = text.match(DIGIT_RE);
  if (digitMatch) {
    const n = parseInt(digitMatch[1], 10);
    const translated = resolveNumberToLabel(n, options);
    if (translated !== null) {
      return {
        action: "translate",
        translated,
        reason: `digit-${n} → "${translated}"`,
      };
    }
    // 数字越界 → passthrough，交给 extractor 兜底走 retry
    return {
      action: "passthrough",
      reason: `digit-${n} out-of-range`,
    };
  }

  // ── 4. 其他 → passthrough（skip/名字/id 都在这里）──────────────────
  return {
    action: "passthrough",
    reason: "verbatim (skip/name/short-id/other)",
  };
}

// ── 数字 → label 查表 ─────────────────────────────────────────────────

/**
 * 把第 N 个选项（**全表 1-based 序号**）映射回 label。
 *
 * - asset_confirm：N=1 → ASSET_CONFIRM_YES 关键字；N=2 → ASSET_CONFIRM_NO 关键字
 *   （直接透传"是,关联团队资产" / "否,本次不关联"这类完整字符串会被
 *   extractAssetConfirm 精确命中）
 * - team / agent_select / task_select：取全表第 N 项的 name（不带
 *   括号 short-id 后缀，CB substring 匹配 name 本身就够）
 *
 * 数字寻址与分页无关：用户在第 2 页输 "14" 也能直接命中全表第 14 项，
 * 与渲染层输出的绝对序号（`absoluteIdx = offset + i + 1`）保持一致。
 *
 * 返回 null 表示 N 越界（> 全表长度）/ stage 不认识。
 */
function resolveNumberToLabel(
  n: number,
  options: PreprocessOptions,
): string | null {
  if (n < 1) return null;

  switch (options.stage) {
    case "asset_confirm": {
      // asset_confirm 只有 2 个固定选项，不分页。extractAssetConfirm 认
      // "是" / "否" / "关联"等关键字，直接返回精确字面串。
      if (n === 1) return "是，关联团队资产";
      if (n === 2) return "否，本次不关联";
      return null;
    }

    case "team": {
      if (n > options.teams.length) return null;
      const item = options.teams[n - 1] as TeamOption;
      return item.team_name;
    }

    case "agent_select": {
      const team = findTeam(options.teams, options.selectedTeamId);
      if (!team) return null;
      if (n > team.agents.length) return null;
      const item = team.agents[n - 1] as AgentInTeam;
      return item.agent_name;
    }

    case "task_select": {
      const team = findTeam(options.teams, options.selectedTeamId);
      if (!team) return null;
      if (n > team.tasks.length) return null;
      const item = team.tasks[n - 1] as TaskInTeam;
      // "暂时跳过（不关联任务）" 虚拟条目命中后返回它的原始 label，让
      // extractTaskOnly 走 defaultTaskId 虚拟条目匹配路径；不需要额外
      // 处理。
      return item.task_name;
    }

    // agent_task legacy 分支（CB one-shot 老路径）文字模式不会走到，
    // 因为 workbuddy 强制走拆分后的 agent_select / task_select。
    default:
      return null;
  }
}

// ── 工具函数 ───────────────────────────────────────────────────────────

function findTeam(
  teams: readonly TeamOption[],
  selectedTeamId: string | undefined,
): TeamOption | undefined {
  if (!selectedTeamId) return undefined;
  return teams.find((t) => t.team_id === selectedTeamId);
}

/**
 * 获取当前 stage 的候选总数（用于计算 totalPages，仅 next/prev clamp 用）。
 * asset_confirm 只有 2 项固定，永远单页，返回 2。
 * team → teams.length；agent_select → team.agents.length；task_select → team.tasks.length。
 * 找不到 team → 0（totalPages=1，next clamp 到 0，等于原地不动）。
 */
function getTotalItemsForStage(options: PreprocessOptions): number {
  switch (options.stage) {
    case "asset_confirm":
      return 2;
    case "team":
      return options.teams.length;
    case "agent_select": {
      const team = findTeam(options.teams, options.selectedTeamId);
      return team?.agents.length ?? 0;
    }
    case "task_select": {
      const team = findTeam(options.teams, options.selectedTeamId);
      return team?.tasks.length ?? 0;
    }
    default:
      return 0;
  }
}

// ── 导出常量（给测试用）──────────────────────────────────────────────

export const _internals = {
  NEXT_RE,
  PREV_RE,
  DIGIT_RE,
  YES_RE,
  NO_RE,
  WB_MORE_LABEL,
  WB_SKIP_LABEL,
};
