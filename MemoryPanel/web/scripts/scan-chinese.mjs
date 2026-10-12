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
 *   - 排除代码注释（// 开头、* 开头、/* 开头的行）
 *   - 检测含 CJK 统一汉字（U+4E00–U+9FFF）的行
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

/** 判断一行是否为纯注释行（// 开头、* 开头、/* 开头） */
function isCommentLine(line) {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*')
  );
}

/**
 * 剥离行内注释（// 到行尾），但避免误删字符串字面量中的 //。
 * 粗略方法：从左到右扫描，跟踪引号状态，只在引号外遇到 // 时截断。
 */
function stripInlineComment(line) {
  let inSingle = false;  // 单引号
  let inDouble = false;  // 双引号
  let inTemplate = false; // 模板字符串反引号
  let escaped = false;
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (!inDouble && !inTemplate && ch === "'") inSingle = !inSingle;
    else if (!inSingle && !inTemplate && ch === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === '`') inTemplate = !inTemplate;
    else if (!inSingle && !inDouble && !inTemplate && ch === '/' && next === '/') {
      return line.slice(0, i);
    }
  }
  return line;
}

const CJK_REGEX = /[\u4e00-\u9fff]/;

function scan() {
  const excludeDirs = ['i18n'];
  const files = walk(srcRoot, excludeDirs);

  const results = [];
  let totalHits = 0;

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    const hits = [];

    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      const codeOnly = stripInlineComment(line);
      if (CJK_REGEX.test(codeOnly)) {
        hits.push({ line: i + 1, content: line });
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
