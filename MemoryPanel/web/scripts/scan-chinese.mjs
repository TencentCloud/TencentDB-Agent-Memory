#!/usr/bin/env node
/**
 * scan-chinese.mjs — 扫描 src 下（排除 i18n/ locale 文件）的硬编码中文残留
 *
 * 用法：
 *   node scripts/scan-chinese.mjs              # 扫描并输出报告
 *   node scripts/scan-chinese.mjs --strict     # 发现残留时以非零退出码退出（用于 CI）
 *
 * 规则：
 *   - 扫描 .ts / .tsx 文件
 *   - 排除 src/i18n/ 目录（locale 文件本身就是中文/英文映射表）
 *   - 剥离所有代码注释（行注释、块注释、JSX 注释），
 *     在剥离时考虑字符串字面量，避免误伤 "http://..." 中的 //
 *   - 检测剥离注释后仍含 CJK 统一汉字（U+4E00–U+9FFF）的行
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const srcRoot = join(__dirname, '..', 'src');

/** 递归收集 .ts/.tsx 文件，排除指定目录 */
function walk(dir, excludeDirs = []) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (excludeDirs.includes(entry.name)) continue;
      out.push(...walk(fullPath, excludeDirs));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

/**
 * 逐行剥离代码注释，返回与原文件等行数的处理后字符串数组。
 *
 * 剥离类型：
 *   - // 行注释（直到行尾）
 *   - 块注释（可能跨行）
 *   - JSX 注释（可能跨行）
 *
 * 在字符串字面量（单/双引号/模板字符串）内的注释符不被处理，
 * 避免 "http://..." 被误伤。
 *
 * 跨行状态（inBlock, inJsx, inTemplate）在行之间传递。
 */
function stripCommentsByLine(content) {
  const lines = content.split('\n');
  const output = [];
  let inBlock = false;       // 块注释
  let inJsx = false;         // JSX 注释
  let inTemplate = false;    // `...`（可跨行）

  for (let line of lines) {
    let result = '';
    let i = 0;
    let inSingle = false;
    let inDouble = false;
    let escaped = false;

    while (i < line.length) {
      const ch = line[i];
      const next = line[i + 1];

      if (escaped) { escaped = false; i++; continue; }
      if ((inSingle || inDouble) && ch === '\\') { escaped = true; i++; continue; }

      // ── JSX comment ──
      if (!inSingle && !inDouble && !inTemplate && ch === '{' && line.slice(i, i + 3) === '{/*') {
        inJsx = true;
        i += 3;
        continue;
      }
      if (inJsx) {
        if (ch === '*' && next === '}') { inJsx = false; i += 2; continue; }
        i++;
        continue;
      }

      // ── Block comment ──
      if (!inSingle && !inDouble && !inTemplate && ch === '/' && next === '*') {
        inBlock = true;
        i += 2;
        continue;
      }
      if (inBlock) {
        if (ch === '*' && next === '/') { inBlock = false; i += 2; continue; }
        i++;
        continue;
      }

      // ── Line comment: // ──
      if (!inSingle && !inDouble && !inTemplate && ch === '/' && next === '/') {
        break; // 跳过本行剩余内容
      }

      // ── 字符串字面量状态追踪 ──
      if (!inDouble && !inTemplate && ch === "'") inSingle = !inSingle;
      else if (!inSingle && !inTemplate && ch === '"') inDouble = !inDouble;
      else if (!inSingle && !inDouble && ch === '`') inTemplate = !inTemplate;

      result += ch;
      i++;
    }

    output.push(result);
  }

  return output;
}

const CJK_REGEX = /[\u4e00-\u9fff]/;
const IGNORE_REGEX = /i18n-ignore/;

function scan() {
  const excludeDirs = ['i18n'];
  const files = walk(srcRoot, excludeDirs);

  const results = [];
  let totalHits = 0;

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const strippedLines = stripCommentsByLine(content);
    const originalLines = content.split('\n');
    const hits = [];

    strippedLines.forEach((stripped, i) => {
      // 尊重 // i18n-ignore 或 /* i18n-ignore */ 注释
      if (IGNORE_REGEX.test(originalLines[i])) return;
      if (CJK_REGEX.test(stripped)) {
        hits.push({ line: i + 1, content: originalLines[i] });
        totalHits++;
      }
    });

    if (hits.length > 0) {
      results.push({ file: relative(process.cwd(), file), hits });
    }
  }

  return { results, totalHits };
}

const { results, totalHits } = scan();

console.log('═══════════════════════════════════════════════════════════');
console.log('  中文残留扫描（排除 src/i18n/，排除代码注释）');
console.log('═══════════════════════════════════════════════════════════\n');

if (results.length === 0) {
  console.log('✅ 未发现硬编码中文残留。\n');
  process.exit(0);
}

console.log(`发现 ${results.length} 个文件、共 ${totalHits} 行含中文残留：\n`);

for (const { file, hits } of results.sort((a, b) => b.hits.length - a.hits.length)) {
  console.log(`📄 ${file} (${hits.length} 行)`);
  for (const { line, content } of hits) {
    console.log(`   ${String(line).padStart(4)}: ${content.trim().slice(0, 120)}`);
  }
  console.log('');
}

console.log(`───────────────────────────────────────────────────────────`);
console.log(`合计：${results.length} 个文件、${totalHits} 行中文残留`);
console.log(`───────────────────────────────────────────────────────────\n`);

if (process.argv.includes('--strict')) {
  process.exit(1);
}
