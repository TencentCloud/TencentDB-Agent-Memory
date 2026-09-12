#!/usr/bin/env node
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(root, "dist");
const entryName = "memory-tencentdb-claude-hook.mjs";
const targetDir = path.join(root, "claude-code-plugin", "scripts");
const target = path.join(targetDir, "memory-hook.mjs");

async function localBundleGraph(name, found = new Set()) {
  if (found.has(name)) return found;
  found.add(name);
  const source = await readFile(path.join(distDir, name), "utf8");
  const imports = source.matchAll(
    /\b(?:from\s*|import\s*)["']\.\/([^"']+)["']/g,
  );
  for (const match of imports) {
    await localBundleGraph(match[1], found);
  }
  return found;
}

await mkdir(targetDir, { recursive: true });
for (const name of await readdir(targetDir)) {
  if (name.endsWith(".mjs")) {
    await unlink(path.join(targetDir, name));
  }
}

const files = await localBundleGraph(entryName);
for (const name of files) {
  if (name === entryName) continue;
  await copyFile(path.join(distDir, name), path.join(targetDir, name));
}
await copyFile(path.join(distDir, entryName), target);
await chmod(target, 0o755);
process.stdout.write(
  `[memory-tencentdb] staged Claude Code hook and ${files.size - 1} local bundle(s) at ${targetDir}\n`,
);
