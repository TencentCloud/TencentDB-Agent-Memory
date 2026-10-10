import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER_ROOT = fileURLToPath(new URL("../", import.meta.url));
const OFFICIAL_MINIMAX_URL = "https://api.minimaxi.com/anthropic";

class RestoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RestoreError";
    this.code = code;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function timestampName(now) {
  return now().toISOString().replaceAll(":", "-");
}

function parseJsonObject(bytes, role) {
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RestoreError(`${role}-json`, `${role} must be UTF-8 JSON object`);
  }
  try {
    const value = JSON.parse(source);
    if (!isObject(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new RestoreError(`${role}-json`, `${role} must be UTF-8 JSON object`);
  }
}

async function readSource(path) {
  try {
    return await readFile(path);
  } catch {
    throw new RestoreError("source-read", "Unable to read trusted source configuration");
  }
}

async function readTarget(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new RestoreError("target-missing", "Target Claude settings file does not exist");
    }
    throw new RestoreError("target-read", "Unable to read target Claude settings file");
  }
}

function validatedSourceConfig(source) {
  if (!isObject(source.env)) {
    throw new RestoreError("source-env", "Source configuration is missing a valid env object");
  }
  if (source.env.ANTHROPIC_BASE_URL !== OFFICIAL_MINIMAX_URL) {
    throw new RestoreError("source-base-url", "Source is not an official MiniMax direct configuration");
  }
  if (typeof source.env.ANTHROPIC_AUTH_TOKEN !== "string" || source.env.ANTHROPIC_AUTH_TOKEN.trim() === "") {
    throw new RestoreError("source-token", "Source configuration is missing a non-empty MiniMax token");
  }
  return source.env;
}

function mergeDirectMiniMax(target, sourceEnv) {
  if (target.env !== undefined && !isObject(target.env)) {
    throw new RestoreError("target-env", "Target configuration has an invalid env object");
  }
  const env = { ...(target.env ?? {}) };
  env.ANTHROPIC_BASE_URL = sourceEnv.ANTHROPIC_BASE_URL;
  env.ANTHROPIC_AUTH_TOKEN = sourceEnv.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_CUSTOM_HEADERS;
  return { ...target, env };
}

async function atomicReplace(path, serialized, renameFile) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.minimax-restore-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx" });
    parseJsonObject(await readFile(temporaryPath), "replacement");
    try {
      await renameFile(temporaryPath, path);
    } catch {
      throw new RestoreError("replace-failed", "Unable to atomically replace target Claude settings; original remains unchanged");
    }
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

export async function restoreClaudeMiniMax({
  sourcePath,
  userProfile = process.env.USERPROFILE || process.env.HOME || homedir(),
  targetPath = join(userProfile, ".claude", "settings.json"),
  runtimeDir = join(ADAPTER_ROOT, "runtime"),
  now = () => new Date(),
  renameFile = rename
} = {}) {
  if (typeof sourcePath !== "string" || sourcePath.trim() === "") {
    throw new RestoreError("source-path", "A trusted source settings path is required");
  }

  const source = resolve(sourcePath);
  const target = resolve(targetPath);
  const sourceConfig = parseJsonObject(await readSource(source), "source");
  const sourceEnv = validatedSourceConfig(sourceConfig);
  const original = await readTarget(target);
  const targetConfig = parseJsonObject(original, "target");
  const replacement = mergeDirectMiniMax(targetConfig, sourceEnv);
  if (JSON.stringify(replacement) === JSON.stringify(targetConfig)) {
    return { status: "UNCHANGED", sourcePath: source, targetPath: target, backupPath: null };
  }

  const backupPath = join(
    resolve(runtimeDir),
    "backups",
    `restore-claude-minimax-${timestampName(now)}-${process.pid}-${randomUUID().slice(0, 8)}`,
    "settings.json"
  );
  await mkdir(dirname(backupPath), { recursive: true });
  try {
    await writeFile(backupPath, original, { flag: "wx" });
  } catch {
    throw new RestoreError("backup-failed", "Unable to back up the original Claude settings");
  }

  await atomicReplace(target, `${JSON.stringify(replacement, null, 2)}\n`, renameFile);
  return { status: "RESTORED", sourcePath: source, targetPath: target, backupPath };
}

export function formatRestoreResult(result) {
  const backup = result.backupPath ?? "(none)";
  return `[${result.status}] Claude Code MiniMax direct settings\nsource: ${result.sourcePath}\ntarget: ${result.targetPath}\nbackup: ${backup}`;
}

function parseArguments(argv) {
  if (argv.length !== 1 || argv[0].startsWith("-")) {
    throw new RestoreError("usage", "Usage: restore-claude-minimax.mjs <trusted-backup-settings.json>");
  }
  return { sourcePath: argv[0] };
}

export function cliRestoreOptions(sourcePath, environment = process.env) {
  if (environment.CROSS_AGENT_MEMORY_TEST_MODE !== "1") return { sourcePath };
  const userProfile = environment.CROSS_AGENT_MEMORY_TEST_USERPROFILE;
  const runtimeDir = environment.CROSS_AGENT_MEMORY_TEST_RUNTIME_DIR;
  return {
    sourcePath,
    ...(typeof userProfile === "string" && userProfile !== "" ? { userProfile } : {}),
    ...(typeof runtimeDir === "string" && runtimeDir !== "" ? { runtimeDir } : {})
  };
}

async function main() {
  const { sourcePath } = parseArguments(process.argv.slice(2));
  const result = await restoreClaudeMiniMax(cliRestoreOptions(sourcePath));
  process.stdout.write(`${formatRestoreResult(result)}\n`);
}

function restoreFailureMessage(error) {
  if (error?.code === "usage") return error.message;
  return "[FAIL] Claude Code MiniMax direct settings were not restored; no configuration contents were displayed.";
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${restoreFailureMessage(error)}\n`);
    process.exitCode = 1;
  });
}
