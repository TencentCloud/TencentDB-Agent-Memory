/**
 * Cursor 安装器：安全合并用户级或项目级 `.cursor` 中的 Hook、MCP 和 Rule。
 * 边界仅限文件系统安装与卸载；所有权由 CURSOR_ADAPTER_MARKER 判定。
 */

import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const CURSOR_ADAPTER_MARKER = "tencentdb-memory-cursor-v1";
const MCP_NAME = "tencentdb-memory";
const RULE_NAME = "tencentdb-memory.mdc";
const HOOK_EVENTS = [
  "sessionStart",
  "stop",
  "sessionEnd",
] as const;

export interface CursorInstallOptions {
  scope: "user" | "project";
  home: string;
  projectRoot: string;
  executablePath: string;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function scopeDir(
  scope: CursorInstallOptions["scope"],
  options: CursorInstallOptions,
): string {
  return scope === "user"
    ? path.join(options.home, ".cursor")
    : path.join(options.projectRoot, ".cursor");
}

async function readJson(filePath: string): Promise<JsonObject> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("root must be an object");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(
      `Cannot safely parse ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function writeJsonAtomic(
  filePath: string,
  value: JsonObject,
): Promise<void> {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  const current = await readFile(filePath, "utf8").catch(() => undefined);
  if (current === next) return;

  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  await writeFile(tempPath, next, { mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, filePath);
}

function quoteCommandToken(token: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(token)) return token;
  return `'${token.replaceAll("'", "'\\''")}'`;
}

function adapterCommand(executablePath: string): string {
  return [
    quoteCommandToken(executablePath),
    "hook",
    CURSOR_ADAPTER_MARKER,
  ].join(" ");
}

function isOwnedHook(value: unknown, executablePath: string): boolean {
  const command = asObject(value)?.command;
  if (typeof command !== "string") return false;
  if (command === adapterCommand(executablePath)) return true;

  const suffix = ` hook ${CURSOR_ADAPTER_MARKER}`;
  if (!command.endsWith(suffix)) return false;
  const token = command.slice(0, -suffix.length);
  const quoted = token.startsWith("'") && token.endsWith("'");
  const unquoted = quoted
    ? token.slice(1, -1).replaceAll("'\\''", "'")
    : token;
  if (!unquoted || (!quoted && /\s/u.test(unquoted))) return false;
  return path.basename(unquoted) === "memory-tencentdb-cursor";
}

function containsOwnedHook(
  value: unknown,
  executablePath: string,
): boolean {
  const hooks = asObject(asObject(value)?.hooks);
  if (!hooks) return false;
  return Object.values(hooks).some(
    (commands) =>
      Array.isArray(commands) &&
      commands.some((hook) => isOwnedHook(hook, executablePath)),
  );
}

function isOwnedMcp(value: unknown): boolean {
  const env = asObject(asObject(value)?.env);
  return env?.MEMORY_TENCENTDB_CURSOR_ADAPTER === CURSOR_ADAPTER_MARKER;
}

const RULE_CONTENT = `---
description: 在任务依赖历史偏好、既往决策或项目经验时检索 TencentDB Memory
alwaysApply: true
---

<!-- ${CURSOR_ADAPTER_MARKER} -->

任务依赖历史偏好、既往决策或项目经验时, 先调用 tdai_memory_search.

需要原话、时间线或证据时, 再调用 tdai_conversation_search.

命中场景导航后, 使用其中的相对 path 调用 tdai_read_cos 读取 L2 正文.
自包含任务不主动检索.
`;

export async function installCursorAdapter(
  options: CursorInstallOptions,
): Promise<void> {
  const targetDir = scopeDir(options.scope, options);
  const otherScope = options.scope === "user" ? "project" : "user";
  const otherHooksPath = path.join(
    scopeDir(otherScope, options),
    "hooks.json",
  );
  const otherHooks = await readJson(otherHooksPath);
  if (containsOwnedHook(otherHooks, options.executablePath)) {
    throw new Error(
      `${CURSOR_ADAPTER_MARKER} already exists in ${otherHooksPath}`,
    );
  }

  const hooksPath = path.join(targetDir, "hooks.json");
  const hooksConfig = await readJson(hooksPath);
  hooksConfig.version ??= 1;
  const hooks = hooksConfig.hooks === undefined
    ? {}
    : asObject(hooksConfig.hooks);
  if (!hooks) {
    throw new Error("hooks conflict: expected a plain object");
  }
  hooksConfig.hooks = hooks;
  for (const [event, commands] of Object.entries(hooks)) {
    if (!Array.isArray(commands)) continue;
    hooks[event] = commands.filter(
      (hook) => !isOwnedHook(hook, options.executablePath),
    );
  }
  const command = adapterCommand(options.executablePath);
  for (const event of HOOK_EVENTS) {
    const current = hooks[event];
    if (current !== undefined && !Array.isArray(current)) {
      throw new Error(`Hook ${event} conflict: expected an array`);
    }
    const existing: unknown[] = current ?? [];
    if (!existing.some((hook) => isOwnedHook(hook, options.executablePath))) {
      existing.push({ command });
    }
    hooks[event] = existing;
  }

  const mcpPath = path.join(targetDir, "mcp.json");
  const mcpConfig = await readJson(mcpPath);
  const mcpServers = mcpConfig.mcpServers === undefined
    ? {}
    : asObject(mcpConfig.mcpServers);
  if (!mcpServers) {
    throw new Error("mcpServers conflict: expected a plain object");
  }
  mcpConfig.mcpServers = mcpServers;
  const currentMcp = mcpServers[MCP_NAME];
  if (
    currentMcp !== undefined &&
    !isOwnedMcp(currentMcp)
  ) {
    throw new Error(`MCP ${MCP_NAME} conflict: entry is not owned by ${CURSOR_ADAPTER_MARKER}`);
  }
  mcpServers[MCP_NAME] = {
    command: options.executablePath,
    args: ["mcp"],
    env: {
      MEMORY_TENCENTDB_CURSOR_ADAPTER: CURSOR_ADAPTER_MARKER,
    },
  };

  const rulePath = path.join(targetDir, "rules", RULE_NAME);
  const currentRule = await readFile(rulePath, "utf8").catch(() => undefined);
  if (
    currentRule !== undefined &&
    !currentRule.includes(CURSOR_ADAPTER_MARKER)
  ) {
    throw new Error(`Rule ${RULE_NAME} conflict: file is not owned by ${CURSOR_ADAPTER_MARKER}`);
  }

  await writeJsonAtomic(hooksPath, hooksConfig);
  await writeJsonAtomic(mcpPath, mcpConfig);
  await mkdir(path.dirname(rulePath), { recursive: true, mode: 0o700 });
  if (currentRule !== RULE_CONTENT) {
    await writeFile(rulePath, RULE_CONTENT, { mode: 0o600 });
  }
}

export async function uninstallCursorAdapter(
  options: CursorInstallOptions,
): Promise<void> {
  const targetDir = scopeDir(options.scope, options);
  const hooksPath = path.join(targetDir, "hooks.json");
  const hooksConfig = await readJson(hooksPath);
  const hooks = asObject(hooksConfig.hooks);
  if (hooks) {
    for (const [event, commands] of Object.entries(hooks)) {
      if (!Array.isArray(commands)) continue;
      hooks[event] = commands.filter(
        (command) => !isOwnedHook(command, options.executablePath),
      );
    }
  }
  if (Object.keys(hooksConfig).length > 0) {
    await writeJsonAtomic(hooksPath, hooksConfig);
  }

  const mcpPath = path.join(targetDir, "mcp.json");
  const mcpConfig = await readJson(mcpPath);
  const mcpServers = asObject(mcpConfig.mcpServers);
  if (mcpServers) {
    const currentMcp = mcpServers[MCP_NAME];
    if (isOwnedMcp(currentMcp)) {
      delete mcpServers[MCP_NAME];
    }
  }
  if (Object.keys(mcpConfig).length > 0) {
    await writeJsonAtomic(mcpPath, mcpConfig);
  }

  const rulePath = path.join(targetDir, "rules", RULE_NAME);
  const rule = await readFile(rulePath, "utf8").catch(() => undefined);
  if (rule?.includes(CURSOR_ADAPTER_MARKER)) {
    await unlink(rulePath).catch(() => undefined);
  }
}
