/**
 * SKILL.md frontmatter 的文本提取。
 *
 * 目录导入时前端要自己读一遍 SKILL.md 里的 name，再连同内容发给 Core；Core 会用
 * parseSkillFile 再解析一次，并要求两边一致（skill-core.ts 的 create 会抛
 * INVALID_FRONTMATTER）。Core 在解析前把 CRLF 归一化成 LF，前端原来没有这一步，
 * 于是 Windows 上（默认 CRLF）的文件前端取不到 name、回退成目录名，两边对不上。
 *
 * 这里把「先归一化换行，再提取」固定下来，保证两边看到同一个 name。
 */

/** 统一换行：CRLF / 单独 CR 都归一化成 LF，与 Core 侧 parseSkillFile 保持一致。 */
export function normalizeNewlines(raw: string): string {
  return raw.replace(/\r\n?/g, '\n');
}

/** 取 frontmatter 的 name；没有 frontmatter、没有 name 字段或值为空都返回 null。 */
export function extractFrontmatterName(raw: string): string | null {
  const text = normalizeNewlines(raw);
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m);
  if (!nameMatch) return null;
  const value = nameMatch[1].trim().replace(/^["']|["']$/g, '');
  return value || null;
}
