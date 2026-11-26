/**
 * skill-import — 「同名 skill 导入 = 确认后替换」用到的纯函数。
 *
 * 单独抽出来是为了可单测：真正的导入编排在 ImportSkillDialog 里（依赖 File /
 * Modal / i18n，只能靠手工回归），而"哪条算同名"这条判定必须可验证。
 */
import type { SkillSummary } from '@/lib/api/skill-api';

/**
 * 从 `skill/list` 的结果里挑出**精确同名**的 active skill。
 *
 * 为什么不能直接用 list 的结果：`filters.name_prefix` 是 SQL `LIKE 'prefix%'`
 * 前缀匹配（`sqlite/skill-store.ts` 的 listSkills），`code-review` 会顺带命中
 * `code-review-helper`。服务端的唯一索引 `(team_id, owner_agent_id, name)
 * WHERE is_head=1 AND status='active'`（skill-store-ddl.ts）是按**全等**建的，
 * 所以前端也必须全等过滤，否则会把"前缀相同"误判成"同名"去弹替换确认。
 *
 * @param items skill/list 的 items（已按 owner_agent_id / status 过滤）
 * @param name  本次要导入的 skill 名（来自 SKILL.md frontmatter）
 */
export function pickSameNameSkill(items: SkillSummary[], name: string): SkillSummary | null {
  const target = name.trim();
  if (!target) return null;
  // 服务端已按 status 过滤，这里再挡一次：archived 同名不占用唯一索引，
  // 也就不该触发"替换"，否则会把历史归档 skill 复活成新版本。
  return items.find((s) => s.name === target && s.status === 'active') ?? null;
}

/**
 * `skill/list` 的 `name_prefix` 查询参数（只用于收窄结果集，命中仍需
 * `pickSameNameSkill` 做全等判定）。skill name 的合法字符集是
 * `^[a-z0-9][a-z0-9-]*$`（见 skill-format.ts），不含 LIKE 的 `%` / `_` 通配符，
 * 因此这里不做转义 —— 真出现异常数据也只是多返回几行，被全等过滤挡掉。
 */
export function namePrefixOf(name: string): string {
  return name.trim();
}
