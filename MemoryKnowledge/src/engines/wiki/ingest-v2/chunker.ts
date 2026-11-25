/**
 * chunker.ts — 超长源的分块。
 *
 * 当源字符数超过模型上下文预算时，把文本切成若干块逐块处理，
 * 块间留少量重叠以保留上下文连续性（INTERFACE §6）。
 *
 * 切分单位（OQ-5 优化）：优先按 markdown 标题（`#`~`######`）边界切，
 * 让每个语义小节尽量完整地落在同一块里；超长小节再回退到按空行段落切，
 * 仍超长的段落最后硬切。避免在句子/小节中间生硬截断。
 */

export interface ChunkOptions {
  /** 单块目标字符数上限（默认 12000）。 */
  targetChars?: number;
  /** 块间重叠字符数（默认 400）。 */
  overlapChars?: number;
}

const DEFAULT_TARGET = 12_000;
const DEFAULT_OVERLAP = 400;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Avoid ending a slice between a UTF-16 surrogate pair. */
function surrogateSafeEnd(text: string, start: number, end: number): number {
  if (
    end > start &&
    end < text.length &&
    isHighSurrogate(text.charCodeAt(end - 1)) &&
    isLowSurrogate(text.charCodeAt(end))
  ) {
    return end - 1;
  }
  return end;
}

/** Return up to `length` trailing code units without starting at a low surrogate. */
function surrogateSafeTail(text: string, length: number): string {
  let start = Math.max(0, text.length - length);
  if (
    start > 0 &&
    start < text.length &&
    isHighSurrogate(text.charCodeAt(start - 1)) &&
    isLowSurrogate(text.charCodeAt(start))
  ) {
    start += 1;
  }
  return text.slice(start);
}

/**
 * 把文本切成「切分单位」数组：每个单位尽量是一个完整的 markdown 小节
 * （从一个标题行到下一个标题行之前）。无标题的开头部分作为独立单位。
 * 超过 target 的单位再按空行段落细分，仍超长的段落硬切。
 */
function splitIntoUnits(text: string, target: number): string[] {
  const lines = text.split("\n");
  // 先按标题行切成小节。
  const sections: string[] = [];
  let cur: string[] = [];
  const isHeading = (line: string) => /^#{1,6}\s+\S/.test(line);
  for (const line of lines) {
    if (isHeading(line) && cur.length > 0) {
      sections.push(cur.join("\n"));
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) sections.push(cur.join("\n"));

  // 超长小节回退细分：先按空行段落，再硬切。
  const units: string[] = [];
  for (const sec of sections) {
    const s = sec.trim();
    if (!s) continue;
    if (s.length <= target) {
      units.push(s);
      continue;
    }
    for (const para of s.split(/\n\s*\n/)) {
      const p = para.trim();
      if (!p) continue;
      if (p.length <= target) {
        units.push(p);
      } else {
        for (let i = 0; i < p.length;) {
          const end = surrogateSafeEnd(p, i, Math.min(p.length, i + target));
          units.push(p.slice(i, end));
          i = end;
        }
      }
    }
  }
  return units;
}

/**
 * 把文本聚合成若干块。每块尽量不超过 targetChars，按 markdown 小节边界聚合。
 *
 * @returns 块数组；输入为空返回 []，不超阈值返回单元素数组。
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const target = Math.max(1000, opts.targetChars ?? DEFAULT_TARGET);
  const overlap = Math.max(0, Math.min(opts.overlapChars ?? DEFAULT_OVERLAP, Math.floor(target / 2)));

  const trimmed = (text ?? "").trim();
  if (!trimmed) return [];
  if (trimmed.length <= target) return [trimmed];

  const units = splitIntoUnits(trimmed, target);

  const chunks: string[] = [];
  let buf = "";
  for (const unit of units) {
    const candidate = buf ? `${buf}\n\n${unit}` : unit;
    if (candidate.length > target && buf) {
      chunks.push(buf);
      // 重叠也必须计入单块上限；单位本身接近 target 时只保留可容纳的部分。
      const separator = "\n\n";
      const availableOverlap = Math.max(0, target - unit.length - separator.length);
      const tailLength = Math.min(overlap, availableOverlap);
      const tail = tailLength > 0 ? surrogateSafeTail(buf, tailLength) : "";
      buf = tail ? `${tail}${separator}${unit}` : unit;
    } else {
      buf = candidate;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/** 粗略估算字符串的 token 数（保守 len/3）。用于判断是否需要分块。 */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? "").length / 3);
}
