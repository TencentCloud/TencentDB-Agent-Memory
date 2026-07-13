#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TEXT_EXTENSIONS = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".md", ".mjs", ".ps1",
  ".py", ".sh", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);
const TEXT_FILENAMES = new Set([".editorconfig", ".gitattributes", ".gitignore", ".npmignore"]);

// Signatures produced when UTF-8 punctuation/emoji is decoded through a
// Windows legacy code page and written back as UTF-8. Keep this list narrow:
// ordinary Chinese, accented Latin text, Japanese, and emoji must remain valid.
const MOJIBAKE_PATTERNS = [
  { name: "UTF-8 decoded as Windows-1252", regex: /(?:\u00e2\u20ac.|\u00e2\u2020.|\u00e2\u2030.|\u00f0\u0178..|\u00ef\u00bf\u00bd|\u00c3[\u0080-\u00bf])/gu },
  { name: "UTF-8 decoded as a CJK legacy code page", regex: /(?:\u9225.|\u922b.|\u9983.|\u951f\u65a4\u62f7|\u9251.|\u9252.|\u9239.)/gu },
];

export function inspectTextBuffer(buffer, file = "<buffer>") {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return [{ file, kind: "invalid-utf8", line: 1, column: 1, message: "file is not valid UTF-8" }];
  }

  const findings = [];
  if (requiresUtf8Bom(file) && !hasUtf8Bom(buffer)) {
    findings.push({
      file,
      kind: "missing-utf8-bom",
      line: 1,
      column: 1,
      message: "PowerShell scripts must use UTF-8 with BOM",
    });
  }

  for (const pattern of MOJIBAKE_PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (const match of text.matchAll(pattern.regex)) {
      const { line, column } = lineAndColumn(text, match.index ?? 0);
      findings.push({
        file,
        kind: "mojibake",
        line,
        column,
        message: `${pattern.name} signature ${JSON.stringify(match[0])}`,
      });
    }
  }

  let replacementIndex = text.indexOf("\uFFFD");
  while (replacementIndex !== -1) {
    const { line, column } = lineAndColumn(text, replacementIndex);
    findings.push({ file, kind: "replacement-character", line, column, message: "contains U+FFFD replacement character" });
    replacementIndex = text.indexOf("\uFFFD", replacementIndex + 1);
  }
  return findings;
}

export function isTextPath(file) {
  const normalized = file.replaceAll("\\", "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return TEXT_FILENAMES.has(name) || TEXT_EXTENSIONS.has(extname(name).toLowerCase());
}

function requiresUtf8Bom(file) {
  return extname(file.replaceAll("\\", "/")).toLowerCase() === ".ps1";
}

function hasUtf8Bom(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
}

async function main() {
  const root = process.cwd();
  const requested = process.argv.slice(2);
  const files = requested.length > 0 ? requested : trackedFiles(root);
  const findings = [];

  for (const file of files.filter(isTextPath)) {
    const absolute = resolve(root, file);
    findings.push(...inspectTextBuffer(await readFile(absolute), relative(root, absolute).replaceAll("\\", "/")));
  }

  if (findings.length === 0) {
    console.log(`Encoding check passed (${files.filter(isTextPath).length} tracked text files).`);
    return;
  }

  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}:${finding.column}: ${finding.message}`);
    if (process.env.GITHUB_ACTIONS) {
      console.error(`::error file=${escapeAnnotation(finding.file)},line=${finding.line},col=${finding.column}::${escapeAnnotation(finding.message)}`);
    }
  }
  process.exitCode = 1;
}

function trackedFiles(root) {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "buffer" });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.toString("utf8").trim()}`);
  }
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

function lineAndColumn(text, index) {
  const prefix = text.slice(0, index);
  const line = prefix.split("\n").length;
  const lastNewline = prefix.lastIndexOf("\n");
  return { line, column: index - lastNewline };
}

function escapeAnnotation(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
