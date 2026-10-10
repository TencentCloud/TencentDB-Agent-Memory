/**
 * L1 记忆的用户归属归一化（确定性护栏）。
 *
 * 背景（2026-09-24 实测事故）：纯提示词约束挡不住模型往「用户（X）」的姓名
 * 括号里填非姓名内容——路径片段（C:\Users\28951）、角色标签（导师/开发者）、
 * 时间状语（"在 2026 年 9 月 24 日"）、甚至命理排盘原文。护栏只禁了"第三方
 * 姓名"，模型用其他垃圾绕开了，产出「用户（王缘林）」「用户（导师）」这类
 * 身份误归属，并经 L2/L3 聚合扩散。
 *
 * 规则：出现 `用户（X）` 时——
 *   - X ∈ 自指词（用户/本人/我…）→ 归一为「用户」
 *   - X ∈ 配置白名单（userIdentityNames，用户自述或系统注入的姓名）→ 原样保留
 *   - 其余一切（第三方姓名、角色、路径数字、状语、乱码）→ 丢弃括号、归一为
 *     「用户」，并回传被丢弃的标签供日志审计
 *
 * 事实不丢：错位的括号内容在 L0 原文与场景文件里仍可追溯。
 */

/** 自指词：这些标签等价于"用户"本身，不构成第三方归属。 */
const SELF_LABELS = new Set(["用户", "本人", "我", "用户本人", "自己"]);

// 半角/全角括号都覆盖；限长避免误吞长句
const ATTR_RE = /用户[（(]([^）)]{1,60})[）)]/g;

export interface AttributionSanitizeResult {
  text: string;
  /** 被丢弃的伪姓名标签（去重、保序） */
  dropped: string[];
}

export function sanitizeUserAttribution(
  text: string,
  allowedNames: string[] = [],
): AttributionSanitizeResult {
  if (!text || !text.includes("用户")) return { text, dropped: [] };
  const allow = new Set(allowedNames.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const dropped: string[] = [];
  const out = text.replace(ATTR_RE, (match, raw: string) => {
    const label = raw.trim();
    if (SELF_LABELS.has(label)) return "用户";
    if (allow.has(label.toLowerCase())) return match;
    if (!dropped.includes(label)) dropped.push(label);
    return "用户";
  });
  return { text: out, dropped };
}
