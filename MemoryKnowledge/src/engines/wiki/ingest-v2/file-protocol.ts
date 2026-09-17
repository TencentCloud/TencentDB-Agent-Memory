/**
 * file-protocol.ts — 解析 LLM 输出的 FILE 块协议并校验落盘路径。
 *
 * LLM 不能自由写文件；它输出带边界标记的文本协议，由我们解析后落盘：
 *
 *   <<<FILE path="wiki/sources/redis.md">>>
 *   ---
 *   type: source
 *   ...
 *   ---
 *   正文...
 *   <<<END>>>
 *
 * 一次响应可含多个 FILE 块。解析要容错（INTERFACE §5.1 / §7）：
 *   - 丢弃未闭合块（截断/超 token 时常见）。
 *   - 非法 path（非 wiki/ 内、含 ..、绝对路径）跳过并记录，不抛错。
 */

export interface ParsedFile {
  /** 规范化后的相对路径，保证位于 wiki/ 内（如 "wiki/entities/redis.md"）。 */
  path: string;
  /** 文件完整内容（含 frontmatter）。 */
  content: string;
}

export interface ParseResult {
  files: ParsedFile[];
  /** 被跳过/丢弃的块的原因，用于日志与调试。 */
  warnings: string[];
}

/**
 * 开标签：标准为 >>>；模型偶发漏写一个 > 变成 >>。
 * 接受 ≥2 个收尾 >，避免「长输出但 files=0」。
 */
const OPEN_RE = /<<<FILE\s+path\s*=\s*"([^"]*)"\s*>>+/g;
/**
 * 闭标签：标准为 <<<END>>>；模型偶发拆成 <<<\nEND>>>。
 * 仅放宽 END 两侧空白（含换行），仍要求字面 END。
 */
const CLOSE_RE = /<<<\s*END\s*>>>/g;

/**
 * 校验并规范化 FILE 块声明的 path。
 * 返回规范化路径（POSIX 风格、wiki/ 前缀）或 null（非法，应跳过）。
 *
 * 规则：
 *   - 必须是相对路径（拒绝绝对路径 / 盘符）。
 *   - 拆分后任一段不得为 ".." 或 "."（防穿越）。
 *   - 规范化后必须以 "wiki/" 开头（只允许写 wiki/**）。
 */
export function normalizeWikiPath(raw: string): string | null {
  if (!raw) return null;
  // 统一分隔符为 /
  let p = raw.trim().replace(/\\/g, "/");
  if (!p) return null;
  // 拒绝绝对路径与 Windows 盘符
  if (p.startsWith("/") || /^[a-zA-Z]:\//.test(p)) return null;
  // 去掉冗余的 ./ 前缀
  p = p.replace(/^(\.\/)+/, "");
  const segments = p.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  // 防穿越：任何一段是 .. 或 . 都拒绝
  for (const seg of segments) {
    if (seg === ".." || seg === ".") return null;
  }
  const normalized = segments.join("/");
  // 白名单：只允许写 wiki/**（且不能就是 "wiki" 目录本身）
  if (normalized !== "wiki" && !normalized.startsWith("wiki/")) return null;
  if (normalized === "wiki") return null;
  return normalized;
}

/**
 * 解析一段 LLM 输出文本，提取所有合法的 FILE 块。
 *
 * @param text LLM 原始响应文本
 * @returns 合法文件列表 + 警告（被跳过的块）
 */
export function parseFileBlocks(text: string): ParseResult {
  const files: ParsedFile[] = [];
  const warnings: string[] = [];
  if (!text) return { files, warnings };

  OPEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = OPEN_RE.exec(text)) !== null) {
    const rawPath = match[1];
    const bodyStart = OPEN_RE.lastIndex;
    CLOSE_RE.lastIndex = bodyStart;
    const closeMatch = CLOSE_RE.exec(text);

    if (!closeMatch) {
      // 未闭合块 → 丢弃（通常是输出被截断）
      warnings.push(`未闭合的 FILE 块，已丢弃: path="${rawPath}"`);
      break;
    }

    // 防止下一次匹配跨过本块的 END
    const closeIdx = closeMatch.index;
    const rawContent = text.slice(bodyStart, closeIdx);
    OPEN_RE.lastIndex = closeIdx + closeMatch[0].length;

    const normPath = normalizeWikiPath(rawPath);
    if (!normPath) {
      warnings.push(`非法 path 已跳过: "${rawPath}"`);
      continue;
    }

    // 去掉块内容首尾多余空行，但保留 frontmatter 结构。
    const content = stripBlockEdges(rawContent);
    if (!content.trim()) {
      warnings.push(`空 FILE 块已跳过: "${normPath}"`);
      continue;
    }

    files.push({ path: normPath, content });
  }

  return { files, warnings };
}

/** 去掉块开头的换行与结尾多余空白，并保证以单个换行结尾。 */
function stripBlockEdges(raw: string): string {
  // 去掉紧跟在 >>> 之后的首个换行
  let s = raw.replace(/^\r?\n/, "");
  // 去掉结尾空白
  s = s.replace(/\s+$/, "");
  if (!s) return "";
  return s + "\n";
}
