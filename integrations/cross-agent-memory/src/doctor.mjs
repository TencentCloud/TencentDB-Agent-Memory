import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.mjs";
import { GatewayClient } from "./gateway-client.mjs";
import { HubClient } from "./hub-client.mjs";
import { MetadataClient } from "./metadata-client.mjs";
import { OFFICIAL_IDENTITY_NAMES } from "./bootstrap-config.mjs";

const DEFAULT_ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_ADAPTER_PATH = fileURLToPath(new URL("./hook-cli.mjs", import.meta.url));
const EVENTS = ["UserPromptSubmit", "Stop"];

function pass(name, detail) {
  return { name, status: "PASS", detail };
}

function fail(name, detail) {
  return { name, status: "FAIL", detail };
}

function wait(name, detail) {
  return { name, status: "WAIT", detail };
}

function nodeSupported(version) {
  const [major, minor] = String(version).split(".").map(Number);
  return Number.isInteger(major) && Number.isInteger(minor) &&
    (major > 22 || (major === 22 && minor >= 16));
}

async function safeCheck(name, operation, successDetail, failureDetail) {
  try {
    await operation();
    return pass(name, successDetail);
  } catch {
    return fail(name, failureDetail);
  }
}

function normalizedPath(value) {
  return String(value).replaceAll("\\", "/").toLowerCase();
}

function normalizedCommand(value) {
  return normalizedPath(value).trim();
}

function validHandler(entry, adapterPath, client) {
  if (entry === null || typeof entry !== "object") return false;
  const path = resolve(adapterPath);
  if (client === "zcode") {
    return entry.type === "process" &&
      entry.command === "node" &&
      Array.isArray(entry.args) &&
      entry.args.length === 2 &&
      normalizedPath(entry.args[0]) === normalizedPath(path) &&
      entry.args[1] === "zcode" &&
      entry.enabled === true &&
      entry.timeoutMs === 5000;
  }
  if (entry.type !== "command" || entry.timeout !== 5) return false;
  if (client === "codex") {
    return normalizedCommand(entry.command) === normalizedCommand(`node ${path.replaceAll("\\", "/")} codex`) &&
      normalizedCommand(entry.commandWindows) === normalizedCommand(`node "${path}" codex`);
  }
  return normalizedCommand(entry.command) === normalizedCommand(`node "${path}" claude`);
}

function groupRegistered(group, adapterPath, client) {
  return Array.isArray(group?.hooks) && group.hooks.some((entry) => validHandler(entry, adapterPath, client));
}

export function isClientHookConfigRegistered(config, client, adapterPath = DEFAULT_ADAPTER_PATH) {
  if (!(["codex", "claude", "zcode"].includes(client))) return false;
  if (client === "zcode") {
    if (config?.hooks?.enabled !== true) return false;
    return EVENTS.every((event) =>
      Array.isArray(config?.hooks?.events?.[event]) &&
      config.hooks.events[event].some((group) => groupRegistered(group, adapterPath, client))
    );
  }
  return EVENTS.every((event) =>
    Array.isArray(config?.hooks?.[event]) &&
    config.hooks[event].some((group) => groupRegistered(group, adapterPath, client))
  );
}

async function readJson(path) {
  const source = await readFile(path, "utf8");
  const parsed = JSON.parse(source);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
  return parsed;
}

async function hookRegistered({ client, userProfile, adapterPath }) {
  const configPath = client === "codex"
    ? join(userProfile, ".codex", "hooks.json")
    : client === "claude"
      ? join(userProfile, ".claude", "settings.json")
      : join(userProfile, ".zcode", "cli", "config.json");
  const config = await readJson(configPath);
  return isClientHookConfigRegistered(config, client, adapterPath);
}

async function defaultHealthCheck(config) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(config.timeouts.recallMs, 1200));
  try {
    const response = await fetch(`${config.endpoint}/health`, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "x-tdai-service-id": config.serviceId
      }
    });
    if (!response.ok) throw new Error("unavailable");
    return true;
  } finally {
    clearTimeout(timer);
  }
}

function validEntity(entity, idField, prefix, statuses) {
  return entity !== null && typeof entity === "object" && !Array.isArray(entity) &&
    typeof entity[idField] === "string" && entity[idField].startsWith(prefix) && statuses.includes(entity.status);
}

function validUser(entity, userId) {
  return entity !== null && typeof entity === "object" && !Array.isArray(entity) &&
    typeof entity.user_id === "string" && entity.user_id.startsWith("usr-") && entity.user_id === userId;
}

async function deploymentAdminKey(deployDir) {
  const key = (await readFile(join(deployDir, ".admin-key"), "utf8")).trim();
  if (!key) throw new Error("missing key");
  return key;
}

async function defaultMetadataClient(config, deployDir) {
  const key = await deploymentAdminKey(deployDir);
  return new MetadataClient({ ...config, userKey: key, timeoutMs: config.timeouts.captureMs });
}

async function defaultHubClient(config, deployDir) {
  const key = await deploymentAdminKey(deployDir);
  return new HubClient({
    endpoint: config.hubEndpoint,
    serviceId: config.serviceId,
    userKey: key,
    timeoutMs: config.timeouts.recallMs
  });
}

async function officialIdentityValid(metadata, identity) {
  const [user, team, agent, task] = await Promise.all([
    metadata.getUser(identity.userId),
    metadata.getTeam(identity.teamId),
    metadata.getAgent(identity.agentId),
    metadata.getTask(identity.taskId)
  ]);
  if (!validUser(user, identity.userId) ||
    !validEntity(team, "team_id", "team-", ["active"]) || team.team_id !== identity.teamId || team.name !== OFFICIAL_IDENTITY_NAMES.team || team.owner_user_id !== identity.userId ||
    !validEntity(agent, "agent_id", "agt-", ["active"]) || agent.agent_id !== identity.agentId || agent.name !== OFFICIAL_IDENTITY_NAMES.agent || agent.team_id !== identity.teamId || agent.owner_user_id !== identity.userId || agent.visibility !== "team" ||
    !validEntity(task, "task_id", "task-", ["running", "completed"]) || task.task_id !== identity.taskId || task.title !== OFFICIAL_IDENTITY_NAMES.task || task.team_id !== identity.teamId || task.creator_user_id !== identity.userId) {
    return false;
  }
  const links = await metadata.listTaskAgents({ taskId: identity.taskId });
  return Array.isArray(links) && links.some((link) => link !== null && typeof link === "object" &&
    link.task_id === identity.taskId && link.agent_id === identity.agentId && link.status === "active");
}

function validHubBlock(block, identity) {
  return block !== null && typeof block === "object" && !Array.isArray(block) &&
    block.id === `chat_memory-${identity.teamId}-${identity.agentId}` &&
    block.agent_id === identity.agentId &&
    block.title === OFFICIAL_IDENTITY_NAMES.agent &&
    block.uploaded_by_user_id === identity.userId;
}

function validHubList(data) {
  return data !== null && typeof data === "object" && !Array.isArray(data) &&
    Array.isArray(data.items) && Number.isInteger(data.total) && data.total >= 0 && data.total === data.items.length;
}

function validL0Layer(data) {
  return data !== null && typeof data === "object" && !Array.isArray(data) && data.layer === "L0" &&
    Array.isArray(data.items) && Number.isInteger(data.total) && data.total >= 0 &&
    data.limit === 1 && data.offset === 0 && data.items.length <= 1 &&
    data.total >= data.items.length && ((data.total === 0) === (data.items.length === 0));
}

export async function runDoctor({
  rootDir = DEFAULT_ROOT_DIR,
  userProfile = process.env.USERPROFILE || process.env.HOME || homedir(),
  adapterPath = DEFAULT_ADAPTER_PATH,
  nodeVersion = process.versions.node,
  write = false,
  healthCheck = defaultHealthCheck,
  gatewayFactory = (config) => new GatewayClient(config),
  deployDir = resolve(DEFAULT_ROOT_DIR, "..", "..", "deploy", "global-images"),
  metadataClient,
  metadataClientFactory = defaultMetadataClient,
  hubClient,
  hubClientFactory = defaultHubClient,
  hookChecker
} = {}) {
  const checks = [];
  let config;
  let gateway;
  try {
    config = await loadConfig(rootDir);
    gateway = gatewayFactory(config);
    checks.push(pass("config", "本机配置完整"));
  } catch {
    checks.push(fail("config", "本机配置不可用"));
  }

  checks.push(nodeSupported(nodeVersion)
    ? pass("node", `Node ${nodeVersion} 可用`)
    : fail("node", "需要 Node 22.16 或更高版本"));

  if (!config || !gateway) {
    checks.push(fail("gateway", "无法在配置缺失时检查 Gateway"));
    checks.push(fail("l0", "无法在配置缺失时检查 L0"));
    checks.push(fail("l1", "无法在配置缺失时检查 L1"));
    checks.push(fail("l3", "无法在配置缺失时检查 L3"));
  } else {
    checks.push(await safeCheck(
      "gateway",
      () => healthCheck(config),
      "MemoryCore Gateway 可连接",
      "MemoryCore Gateway 不可连接"
    ));
    checks.push(await safeCheck(
      "l0",
      () => gateway.searchConversation("cross-agent-memory-doctor", 1),
      "L0 查询可用",
      "L0 查询失败"
    ));
    checks.push(await safeCheck(
      "l1",
      () => gateway.searchAtomic("cross-agent-memory-doctor", 1),
      "L1 查询可用",
      "L1 查询失败"
    ));
    checks.push(await safeCheck(
      "l3",
      () => gateway.readCore(),
      "L3 读取可用",
      "L3 读取失败"
    ));
  }

  let metadata;
  let identityValid = false;
  if (!config) {
    checks.push(fail("identity", "配置缺失，无法验证正式身份"));
  } else {
    try {
      metadata = metadataClient ?? await metadataClientFactory(config, deployDir);
      if (!await officialIdentityValid(metadata, config.identity)) throw new Error("invalid graph");
      identityValid = true;
      checks.push(pass("identity", "正式身份存在、归属一致且状态有效"));
    } catch {
      checks.push(fail("identity", "正式身份不存在、归属不一致或状态无效"));
    }
  }

  if (!config || !gateway) {
    checks.push(fail("write", "无法在配置缺失时检查写入"));
  } else if (!write) {
    checks.push(pass("write", "可选写入测试未启用"));
  } else if (!identityValid) {
    checks.push(fail("write", "正式身份无效，未执行可选写入测试"));
  } else {
    const timestamp = new Date().toISOString();
    checks.push(await safeCheck(
      "write",
      () => gateway.addConversation("doctor-connectivity-check", [
        { role: "user", content: "cross-agent-memory-doctor", timestamp },
        { role: "assistant", content: "doctor-ok", timestamp }
      ]),
      "可选写入测试成功",
      "可选写入测试失败"
    ));
  }

  if (!config) {
    checks.push(fail("chat-memory", "配置缺失，无法验证 Hub chat_memory"));
  } else if (!identityValid) {
    checks.push(fail("chat-memory", "正式身份无效，无法验证 Hub chat_memory"));
  } else try {
    const hub = hubClient ?? await hubClientFactory(config, deployDir);
    const blocks = await hub.listMyAgents({ teamId: config.identity.teamId });
    if (!validHubList(blocks)) throw new Error("invalid Hub list");
    const expected = blocks.items.filter((block) => validHubBlock(block, config.identity));
    if (expected.length !== 1) throw new Error("missing official Hub block");
    const blockId = `chat_memory-${config.identity.teamId}-${config.identity.agentId}`;
    const layer = await hub.readLayer({ blockId, layer: "L0", limit: 1, offset: 0 });
    if (!validL0Layer(layer)) throw new Error("invalid Hub layer");
    if (layer.total === 0) {
      checks.push(wait("chat-memory", "Hub 可连接且正式记忆块可见；尚未首写 L0"));
    } else {
      checks.push(pass("chat-memory", `Hub 正式记忆块可见，L0 共 ${layer.total} 条`));
    }
  } catch {
    checks.push(fail("chat-memory", "Memory Hub 不可连接、正式记忆块无效或 L0 无法读取"));
  }

  for (const client of ["codex", "claude", "zcode"]) {
    checks.push(await safeCheck(
      `hook-${client}`,
      async () => {
        const registered = hookChecker
          ? await hookChecker(client)
          : await hookRegistered({ client, userProfile, adapterPath });
        if (!registered) throw new Error("missing");
      },
      `${client} 的两个 Hook 已注册`,
      `${client} Hook 未完整注册`
    ));
  }
  return checks;
}

export function formatDoctorReport(checks) {
  return checks.map((check) => `[${check.status}] ${check.name}: ${check.detail}`).join("\n");
}

function parseArguments(argv) {
  let write = false;
  for (const argument of argv) {
    if (argument === "--write") write = true;
    else throw new Error("Usage: doctor.mjs [--write]");
  }
  return { write };
}

async function main() {
  const checks = await runDoctor(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${formatDoctorReport(checks)}\n`);
  if (checks.some((check) => check.status === "FAIL")) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write("[FAIL] doctor: 诊断程序无法完成；未显示配置或对话内容。\n");
    process.exitCode = 1;
  });
}
