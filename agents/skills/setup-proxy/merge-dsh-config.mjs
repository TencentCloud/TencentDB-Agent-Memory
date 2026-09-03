#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANAGED_COMMENT = '# Managed by TencentDB Agent Memory setup-proxy.sh';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseDocument(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  if (lines.at(-1) === '') {
    lines.pop();
  }

  return { eol, lines };
}

function renderDocument({ eol, lines }) {
  return lines.length === 0 ? '' : `${lines.join(eol)}${eol}`;
}

function isTopLevelContent(line) {
  return line !== '' && !/^\s/.test(line) && !/^\s*#/.test(line);
}

function findSection(lines, sectionName) {
  const escapedName = escapeRegExp(sectionName);
  const blockPattern = new RegExp(`^${escapedName}:\\s*(?:#.*)?$`);
  const anyPattern = new RegExp(`^${escapedName}:`);
  const candidates = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (anyPattern.test(lines[index])) {
      candidates.push(index);
    }
  }

  if (candidates.length > 1) {
    throw new Error(`配置中存在重复的顶层 ${sectionName} section，已停止写入`);
  }

  if (candidates.length === 0) {
    return null;
  }

  const start = candidates[0];
  if (!blockPattern.test(lines[start])) {
    throw new Error(
      `${sectionName} 使用了行内 YAML 写法，无法在不破坏原配置的前提下安全合并`,
    );
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isTopLevelContent(lines[index])) {
      end = index;
      break;
    }
  }

  return { start, end };
}

function detectChildIndent(lines, start, end) {
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || /^\s*#/.test(line)) {
      continue;
    }

    const match = line.match(/^( +)\S/);
    if (!match) {
      throw new Error('检测到 tab 或无效缩进，已停止写入以避免破坏 YAML');
    }
    return match[1];
  }

  return '  ';
}

function appendBlock(lines, blockLines) {
  if (lines.length > 0 && lines.at(-1).trim() !== '') {
    lines.push('');
  }
  lines.push(MANAGED_COMMENT, ...blockLines);
}

function updateSection(document, sectionName, values, removeKeys = []) {
  const { lines } = document;
  const section = findSection(lines, sectionName);

  if (!section) {
    const blockLines = [`${sectionName}:`];
    for (const [key, value] of Object.entries(values)) {
      blockLines.push(`  ${key}: ${JSON.stringify(value)}`);
    }
    appendBlock(lines, blockLines);
    return document;
  }

  const indent = detectChildIndent(lines, section.start, section.end);
  const managedKeys = new Set([...Object.keys(values), ...removeKeys]);
  const occurrences = new Map();
  const output = [];

  for (let index = section.start + 1; index < section.end; index += 1) {
    const line = lines[index];
    let matchedKey = null;

    for (const key of managedKeys) {
      const keyPattern = new RegExp(`^${escapeRegExp(indent)}${escapeRegExp(key)}:`);
      if (keyPattern.test(line)) {
        matchedKey = key;
        break;
      }
    }

    if (!matchedKey) {
      output.push(line);
      continue;
    }

    occurrences.set(matchedKey, (occurrences.get(matchedKey) ?? 0) + 1);
    if (occurrences.get(matchedKey) > 1) {
      throw new Error(`${sectionName}.${matchedKey} 重复，已停止写入`);
    }

    if (Object.hasOwn(values, matchedKey)) {
      output.push(`${indent}${matchedKey}: ${JSON.stringify(values[matchedKey])}`);
    }
  }

  for (const [key, value] of Object.entries(values)) {
    if (!occurrences.has(key)) {
      output.push(`${indent}${key}: ${JSON.stringify(value)}`);
    }
  }

  lines.splice(section.start + 1, section.end - section.start - 1, ...output);
  return document;
}

function migrateFlatCredentials(document) {
  const { lines } = document;
  const contentLines = lines.filter((line) => line.trim() !== '' && !/^\s*#/.test(line));

  // dsh only migrates the old pre-release layout when every root entry is a
  // scalar credential reference. Mirror that conservative recognition here so
  // setup never turns an unrelated YAML document into a credentials file.
  for (const line of contentLines) {
    if (/^\s/.test(line) || !/^[A-Za-z_][A-Za-z0-9_]*:\s+\S/.test(line)) {
      throw new Error('旧版凭据文件不是可迁移的扁平 key/value 格式，已停止写入');
    }
  }

  const migrated = ['version: 1', 'refs:'];
  for (const line of lines) {
    migrated.push(line === '' ? '' : `  ${line}`);
  }
  document.lines.splice(0, document.lines.length, ...migrated);
}

function updateCredentials(document, key, value) {
  const { lines } = document;
  const versionLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^version:/.test(line));

  if (versionLines.length > 1) {
    throw new Error('凭据中存在重复的 version，已停止写入');
  }

  if (versionLines.length === 0) {
    const hasContent = lines.some((line) => line.trim() !== '' && !/^\s*#/.test(line));
    if (hasContent) {
      migrateFlatCredentials(document);
    } else {
      lines.splice(0, lines.length, 'version: 1', 'refs:');
    }
  } else if (!/^version:\s*1\s*(?:#.*)?$/.test(versionLines[0].line)) {
    throw new Error('只支持 dsh version: 1 凭据格式，已停止写入');
  }

  updateSection(document, 'refs', { [key]: value });
  return document;
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

async function existingMode(path, fallback) {
  try {
    return (await stat(path)).mode;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function writeAtomically(path, content, fallbackMode) {
  await mkdir(dirname(path), { recursive: true });
  const mode = await existingMode(path, fallbackMode);
  const temporaryPath = resolve(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode });
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, path);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        error.cause = cleanupError;
      }
    }
    throw error;
  }
}

export async function mergeDshConfig({
  settingsPath,
  credentialsPath,
  baseUrl,
  model,
  userKey,
}) {
  for (const [name, value] of Object.entries({
    settingsPath,
    credentialsPath,
    baseUrl,
    model,
    userKey,
  })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`${name} 不能为空`);
    }
  }

  const [settingsText, credentialsText] = await Promise.all([
    readText(settingsPath),
    readText(credentialsPath),
  ]);

  const settingsDocument = parseDocument(settingsText);
  updateSection(
    settingsDocument,
    'llm-deepseek',
    {
      apiKeyEnv: 'PROXY_USER_KEY',
      baseURL: baseUrl,
    },
    ['model'],
  );
  updateSection(settingsDocument, 'agent-default-model', {
    provider: 'deepseek-official',
    model,
  });

  const credentialsDocument = parseDocument(credentialsText);
  updateCredentials(credentialsDocument, 'PROXY_USER_KEY', userKey);

  // 两份文件都先完整解析并生成，再开始落盘，避免 YAML 不兼容时只写了一半。
  const settingsOutput = renderDocument(settingsDocument);
  const credentialsOutput = renderDocument(credentialsDocument);

  await writeAtomically(settingsPath, settingsOutput, 0o644);
  await writeAtomically(credentialsPath, credentialsOutput, 0o600);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error(`无效参数: ${flag ?? ''}`);
    }
    options[flag.slice(2)] = value;
  }

  return {
    settingsPath: options.settings,
    credentialsPath: options.credentials,
    baseUrl: options['base-url'],
    model: options.model,
    userKey: process.env.TDAI_DSH_PROXY_USER_KEY,
  };
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  Promise.resolve()
    .then(() => mergeDshConfig(parseArguments(process.argv.slice(2))))
    .catch((error) => {
      process.stderr.write(`合并 dsh 配置失败: ${error.message}\n`);
      process.exitCode = 1;
    });
}
