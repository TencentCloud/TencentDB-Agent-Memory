#!/usr/bin/env node
/**
 * i18n 迁移脚本 — 将 JSX/TSX 中的中文硬编码文案替换为 t() 调用
 * 
 * 此脚本做最小化的 pattern-based 替换，不追求完美。
 * 人工审查后仍需调整。
 */
const fs = require('fs');
const path = require('path');

// 递归遍历目录，找出所有 .ts/.tsx 文件
function walk(dir) {
  let results = [];
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(walk(fullPath));
    } else if (item.endsWith('.tsx') || item.endsWith('.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

const srcDir = path.join(__dirname, 'MemoryPanel', 'web', 'src');
const files = walk(srcDir).filter(f => 
  !f.includes('i18n/') && 
  !f.includes('node_modules') &&
  !f.endsWith('.css')
);

let totalReplacements = 0;

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  let modified = false;
  let count = 0;

  // 检查文件是否已有 useTranslation import
  const hasChinese = /[\u4e00-\u9fff]/.test(content);
  if (!hasChinese) continue;

  // ... (rest of script would go here)
  // This is a placeholder - actual migration done manually per file
  
  if (modified) {
    fs.writeFileSync(file, content);
    totalReplacements += count;
  }
}

console.log(`Done. ${totalReplacements} replacements.`);
