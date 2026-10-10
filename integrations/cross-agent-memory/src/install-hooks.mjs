import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const ADAPTER_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_ADAPTER_PATH = fileURLToPath(new URL("./hook-cli.mjs", import.meta.url));
const ALL_CLIENTS = ["codex", "claude", "zcode"];
const CONFIG_PATHS = {
  codex: [".codex", "hooks.json"],
  claude: [".claude", "settings.json"],
  zcode: [".zcode", "cli", "config.json"]
};
const EVENTS = ["UserPromptSubmit", "Stop"];

function ensureObject(parent, key, label) {
  if (parent[key] === undefined) parent[key] = {};
  if (parent[key] === null || typeof parent[key] !== "object" || Array.isArray(parent[key])) {
    throw new Error(`Invalid configuration: ${label} must be an object`);
  }
  return parent[key];
}

function ensureArray(parent, key, label) {
  if (parent[key] === undefined) parent[key] = [];
  if (!Array.isArray(parent[key])) {
    throw new Error(`Invalid configuration: ${label} must be an array`);
  }
  return parent[key];
}

function normalizedPath(value) {
  return String(value).replaceAll("\\", "/").toLowerCase();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandReferencesAdapter(command, adapterPath) {
  if (typeof command !== "string") return false;
  const normalizedCommand = normalizedPath(command);
  const needle = escapeRegExp(normalizedPath(adapterPath));
  return new RegExp(`(^|[\\s"'])${needle}(?=$|[\\s"'])`).test(normalizedCommand);
}

function referencesAdapter(entry, adapterPath) {
  if (entry === null || typeof entry !== "object") return false;
  const needle = normalizedPath(adapterPath);
  const argumentMatch = Array.isArray(entry.args) && entry.args.some((argument) =>
    typeof argument === "string" && normalizedPath(argument) === needle
  );
  return argumentMatch ||
    commandReferencesAdapter(entry.command, adapterPath) ||
    commandReferencesAdapter(entry.commandWindows, adapterPath);
}

function commandBlockReferencesAdapter(block, adapterPath) {
  return Array.isArray(block?.hooks) && block.hooks.some((entry) => referencesAdapter(entry, adapterPath));
}

function addCommandHooks(config, client, adapterPath) {
  const hooks = ensureObject(config, "hooks", "hooks");
  for (const event of EVENTS) {
    const blocks = ensureArray(hooks, event, `hooks.${event}`);
    if (blocks.some((block) => commandBlockReferencesAdapter(block, adapterPath))) continue;

    const command = client === "codex"
      ? {
          type: "command",
          command: `node ${adapterPath.replaceAll("\\", "/")} codex`,
          commandWindows: `node "${adapterPath}" codex`,
          timeout: 5
        }
      : {
          type: "command",
          command: `node "${adapterPath}" claude`,
          timeout: 5
        };
    blocks.push({ hooks: [command] });
  }
}

function removeCommandHooks(config, adapterPath) {
  const hooks = config?.hooks;
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) return;
  for (const event of EVENTS) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event].flatMap((block) => {
      if (!Array.isArray(block?.hooks)) return [block];
      const remaining = block.hooks.filter((entry) => !referencesAdapter(entry, adapterPath));
      if (remaining.length === block.hooks.length) return [block];
      return remaining.length > 0 ? [{ ...block, hooks: remaining }] : [];
    });
  }
}

function addZcodeHooks(config, adapterPath) {
  const hooks = ensureObject(config, "hooks", "hooks");
  hooks.enabled = true;
  const events = ensureObject(hooks, "events", "hooks.events");
  for (const event of EVENTS) {
    const groups = ensureArray(events, event, `hooks.events.${event}`);
    if (groups.some((group) => commandBlockReferencesAdapter(group, adapterPath))) continue;
    groups.push({
      hooks: [{
        type: "process",
        command: "node",
        args: [adapterPath, "zcode"],
        enabled: true,
        timeoutMs: 5000
      }]
    });
  }
}

function removeZcodeHooks(config, adapterPath) {
  const events = config?.hooks?.events;
  if (events === null || typeof events !== "object" || Array.isArray(events)) return;
  for (const event of EVENTS) {
    if (!Array.isArray(events[event])) continue;
    events[event] = events[event].flatMap((group) => {
      if (!Array.isArray(group?.hooks)) return [group];
      const remaining = group.hooks.filter((entry) => !referencesAdapter(entry, adapterPath));
      if (remaining.length === group.hooks.length) return [group];
      return remaining.length > 0 ? [{ ...group, hooks: remaining }] : [];
    });
  }
}

async function loadConfiguration(configPath) {
  let source;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { config: {}, source: null };
    throw error;
  }

  let config;
  try {
    config = JSON.parse(source);
  } catch {
    throw new Error(`Invalid JSON in ${configPath}`);
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Invalid JSON object in ${configPath}`);
  }
  return { config, source };
}

function backupRunName() {
  return `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

async function atomicWrite({ configPath, config, source, backupPath, renameFile }) {
  await mkdir(dirname(configPath), { recursive: true });
  if (source !== null) {
    await mkdir(dirname(backupPath), { recursive: true });
    await writeFile(backupPath, source, { encoding: "utf8", flag: "wx" });
  }

  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  JSON.parse(serialized);
  const temporaryPath = `${configPath}.cross-agent-memory-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx" });
    JSON.parse(await readFile(temporaryPath, "utf8"));
    await renameFile(temporaryPath, configPath);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

function selectedClients(client) {
  if (client === undefined) return ALL_CLIENTS;
  if (!ALL_CLIENTS.includes(client)) {
    throw new Error(`Unsupported client: ${client}`);
  }
  return [client];
}

async function updateHooks(action, {
  client,
  userProfile = process.env.USERPROFILE || process.env.HOME || homedir(),
  runtimeDir = join(ADAPTER_ROOT, "runtime"),
  adapterPath = DEFAULT_ADAPTER_PATH,
  renameFile = rename
} = {}) {
  if (action !== "install" && action !== "uninstall") {
    throw new Error(`Unsupported action: ${action}`);
  }
  const profile = resolve(userProfile);
  const hookPath = resolve(adapterPath);
  const pending = [];

  for (const currentClient of selectedClients(client)) {
    const relativeParts = CONFIG_PATHS[currentClient];
    const configPath = join(profile, ...relativeParts);
    const { config, source } = await loadConfiguration(configPath);
    const before = JSON.stringify(config);
    if (action === "install") {
      if (currentClient === "zcode") addZcodeHooks(config, hookPath);
      else addCommandHooks(config, currentClient, hookPath);
    } else if (currentClient === "zcode") {
      removeZcodeHooks(config, hookPath);
    } else {
      removeCommandHooks(config, hookPath);
    }
    if (JSON.stringify(config) !== before) {
      pending.push({ client: currentClient, relativeParts, configPath, config, source });
    }
  }

  if (pending.length === 0) return { changed: [], backupDir: null };
  const backupDir = join(resolve(runtimeDir), "backups", backupRunName());
  await mkdir(backupDir, { recursive: true });
  for (const item of pending) {
    await atomicWrite({
      configPath: item.configPath,
      config: item.config,
      source: item.source,
      backupPath: join(backupDir, ...item.relativeParts),
      renameFile
    });
  }
  return { changed: pending.map((item) => item.client), backupDir };
}

export function installHooks(options) {
  return updateHooks("install", options);
}

export function uninstallHooks(options) {
  return updateHooks("uninstall", options);
}

function parseArguments(argv) {
  const [action, ...rest] = argv;
  let client;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--client") {
      client = rest[index + 1];
      index += 1;
    } else if (argument.startsWith("--client=")) {
      client = argument.slice("--client=".length);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { action, client };
}

async function main() {
  const { action, client } = parseArguments(process.argv.slice(2));
  const operation = action === "install" ? installHooks : action === "uninstall" ? uninstallHooks : null;
  if (operation === null) throw new Error("Usage: install-hooks.mjs <install|uninstall> [--client codex|claude|zcode]");
  const result = await operation({ client });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
