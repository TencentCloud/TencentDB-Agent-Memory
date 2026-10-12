#!/usr/bin/env node
/**
 * 中文残留扫描脚本 — 扫描 src 下（排除 locale 文件）是否还有 UI 中文残留
 *
 * 使用方式：
 *   node scripts/scan-chinese.cjs
 *
 * 退出码：
 *   0 — 无残留
 *   1 — 发现中文残留
 */
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'src');
const EXCLUDE_DIRS = ['i18n'];
const CN_RE = /[\u4e00-\u9fff]/;

let hasChinese = false;
let fileCount = 0;
let matchCount = 0;

function walk(dir) {
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const relPath = path.relative(SRC_DIR, fullPath);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      // Skip excluded directories
      if (EXCLUDE_DIRS.includes(item)) continue;
      walk(fullPath);
    } else if ((item.endsWith('.tsx') || item.endsWith('.ts')) && !item.endsWith('.d.ts')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');
      const matches = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        // Skip comment-only lines
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
        // Skip import lines
        if (trimmed.startsWith('import ')) continue;
        if (CN_RE.test(line)) {
          matches.push({ line: i + 1, content: line.trim() });
        }
      }
      if (matches.length > 0) {
        hasChinese = true;
        fileCount++;
        matchCount += matches.length;
        console.log(`\n📄 ${relPath}`);
        matches.forEach(m => {
          console.log(`  L${m.line}: ${m.content.substring(0, 120)}`);
        });
      }
    }
  }
}

console.log('Scanning for Chinese UI text remnants...');
console.log(`Source dir: ${SRC_DIR}`);
console.log(`Excluded: ${EXCLUDE_DIRS.join(', ')}\n`);

walk(SRC_DIR);

console.log('\n' + '='.repeat(60));
if (hasChinese) {
  console.log(`❌ Found Chinese text in ${fileCount} files (${matchCount} matches)`);
  process.exit(1);
} else {
  console.log('✅ No Chinese UI text remnants found!');
  process.exit(0);
}
