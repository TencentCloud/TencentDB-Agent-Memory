import { resolve } from "node:path";
import { MemoryClient, MetadataClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import { getAgentDir, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readSecretFile, saveGlobalSetupConfig, validateEndpoint } from "./config.js";
import { redactText, truncateUtf8 } from "./security.js";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8420";
const DEFAULT_SERVICE_ID = "default";
const DEFAULT_AGENT_NAME = "Pi";
const CREATE_AGENT = "+ Create a private Pi agent";
const PAGE_SIZE = 100;
const MAX_SELECTABLE_ITEMS = 500;

interface Page<T> {
  items: T[];
  total: number;
}

interface SetupUser {
  user_id: string;
  username: string;
}

interface SetupTeam {
  team_id: string;
  name: string;
  status: string;
}

interface SetupAgent {
  agent_id: string;
  team_id: string;
  name: string;
  status: string;
  /** "private" | "team" | "restricted"; missing means not private. */
  visibility?: string;
}

export interface SetupConnection {
  endpoint: string;
  serviceId: string;
  userKey: string;
  gatewayApiKey: string;
  timeoutMs: number;
}

export interface SetupMetadataClient {
  verifyAuth(userKey: string): Promise<{ valid: boolean; user: SetupUser | null }>;
  listTeams(request: { user_id: string; limit: number; offset: number }): Promise<Page<SetupTeam>>;
  listAgents(request: { team_id: string; limit: number; offset: number; status?: "active" }): Promise<Page<SetupAgent>>;
  createAgent(request: {
    team_id: string;
    owner_user_id: string;
    name: string;
    description: string;
    visibility: "private";
    status: "active";
  }): Promise<SetupAgent>;
  archiveAgent(agentId: string): Promise<unknown>;
}

export interface SetupMemoryClient {
  queryConversation(params: { limit: number; offset: number }): Promise<unknown>;
  searchAtomic(params: { query: string; limit: number }): Promise<unknown>;
  listScenarios(): Promise<unknown>;
  readCore(): Promise<unknown>;
}

export interface SetupDependencies {
  agentDir?: string;
  createMetadataClient?: (connection: SetupConnection) => SetupMetadataClient;
  createMemoryClient?: (connection: SetupConnection, isolation: { teamId: string; agentId: string; userId: string }) => SetupMemoryClient;
}

export type SetupResult =
  | { ok: true; configPath: string; createdAgent: boolean }
  | { ok: false; cancelled: boolean; message: string };

function defaultMetadataClient(connection: SetupConnection): SetupMetadataClient {
  return new MetadataClient({
    endpoint: connection.endpoint,
    apiKey: connection.gatewayApiKey,
    serviceId: connection.serviceId,
    userKey: connection.userKey,
    timeout: connection.timeoutMs,
    rejectUnauthorized: true,
  });
}

function defaultMemoryClient(
  connection: SetupConnection,
  isolation: { teamId: string; agentId: string; userId: string },
): SetupMemoryClient {
  return new MemoryClient({
    endpoint: connection.endpoint,
    apiKey: connection.gatewayApiKey,
    serviceId: connection.serviceId,
    teamId: isolation.teamId,
    agentId: isolation.agentId,
    userId: isolation.userId,
    timeout: connection.timeoutMs,
    rejectUnauthorized: true,
  });
}

function cleanInput(value: string | undefined, fallback?: string): string | undefined {
  if (value === undefined) return undefined;
  return value.trim() || fallback;
}

function safeLabel(name: string, id: string): string {
  const cleanName = truncateUtf8(name.replace(/[\u0000-\u001f\u007f]/g, " ").trim() || "Unnamed", 160);
  return `${cleanName} (${id})`;
}

function safeError(error: unknown): string {
  return truncateUtf8(redactText(error instanceof Error ? error.message : String(error)), 500);
}

async function listAll<T>(loadPage: (offset: number) => Promise<Page<T>>, label: string): Promise<T[]> {
  const items: T[] = [];
  for (let offset = 0; offset < MAX_SELECTABLE_ITEMS; offset += PAGE_SIZE) {
    const page = await loadPage(offset);
    items.push(...page.items);
    if (items.length > MAX_SELECTABLE_ITEMS) {
      throw new Error(`More than ${MAX_SELECTABLE_ITEMS} ${label} are available; configure the adapter manually.`);
    }
    if (page.items.length < PAGE_SIZE || offset + page.items.length >= page.total) return items;
  }
  throw new Error(`More than ${MAX_SELECTABLE_ITEMS} ${label} are available; configure the adapter manually.`);
}

async function choose<T>(
  ctx: Pick<ExtensionCommandContext, "ui">,
  title: string,
  items: T[],
  label: (item: T) => string,
): Promise<T | undefined> {
  const byOption = new Map<string, T>();
  for (const item of items) byOption.set(label(item), item);
  const selected = await ctx.ui.select(title, [...byOption.keys()]);
  return selected ? byOption.get(selected) : undefined;
}

async function verifyDataPlane(memory: SetupMemoryClient): Promise<void> {
  await Promise.all([
    memory.queryConversation({ limit: 1, offset: 0 }),
    memory.searchAtomic({ query: "setup capability check", limit: 1 }),
    memory.listScenarios(),
    memory.readCore(),
  ]);
}

/**
 * Interactive, global-only setup. Pi's UI has no masked password input, so
 * this command deliberately accepts key-file paths rather than secret values.
 */
export async function runSetup(
  ctx: Pick<ExtensionCommandContext, "cwd" | "hasUI" | "ui">,
  dependencies: SetupDependencies = {},
): Promise<SetupResult> {
  if (!ctx.hasUI) {
    return { ok: false, cancelled: false, message: "Memory setup requires an interactive Pi UI." };
  }

  const endpoint = cleanInput(await ctx.ui.input("TencentDB Agent Memory endpoint", DEFAULT_ENDPOINT), DEFAULT_ENDPOINT);
  if (!endpoint) return { ok: false, cancelled: true, message: "Memory setup cancelled." };
  const endpointError = validateEndpoint(endpoint);
  if (endpointError) return { ok: false, cancelled: false, message: `Invalid endpoint: ${endpointError}` };

  const serviceId = cleanInput(await ctx.ui.input("Memory service ID", DEFAULT_SERVICE_ID), DEFAULT_SERVICE_ID);
  if (!serviceId) return { ok: false, cancelled: true, message: "Memory setup cancelled." };
  if (serviceId.includes("|")) return { ok: false, cancelled: false, message: "Service ID must not contain |." };

  const userKeyRaw = await ctx.ui.input("User key file path", "For local Docker: deploy/global-images/.admin-key");
  if (userKeyRaw === undefined) return { ok: false, cancelled: true, message: "Memory setup cancelled." };
  const userKeyInput = cleanInput(userKeyRaw);
  if (!userKeyInput) {
    return {
      ok: false,
      cancelled: false,
      message: "A user key file is required. For local Docker, use deploy/global-images/.admin-key; the key is never pasted into Pi.",
    };
  }
  const userKeyFile = resolve(ctx.cwd, userKeyInput);

  const gatewayKeyRaw = await ctx.ui.input(
    "Gateway bearer key file (optional)",
    "Leave blank to reuse the user key for a local gateway",
  );
  if (gatewayKeyRaw === undefined) return { ok: false, cancelled: true, message: "Memory setup cancelled." };
  const gatewayKeyInput = cleanInput(gatewayKeyRaw);
  const gatewayApiKeyFile = gatewayKeyInput ? resolve(ctx.cwd, gatewayKeyInput) : undefined;

  let userKey: string;
  let gatewayApiKey: string;
  try {
    userKey = await readSecretFile(userKeyFile, "user key file");
    gatewayApiKey = gatewayApiKeyFile ? await readSecretFile(gatewayApiKeyFile, "gateway API key file") : userKey;
  } catch (error) {
    return { ok: false, cancelled: false, message: `Cannot read key file: ${safeError(error)}` };
  }

  const connection: SetupConnection = {
    endpoint,
    serviceId,
    userKey,
    gatewayApiKey,
    timeoutMs: 5_000,
  };
  const metadata = (dependencies.createMetadataClient ?? defaultMetadataClient)(connection);
  let createdAgent: SetupAgent | undefined;
  try {
    ctx.ui.setStatus("tdai-memory", "memory: verifying identity");
    const verification = await metadata.verifyAuth(userKey);
    if (!verification.valid || !verification.user) {
      return { ok: false, cancelled: false, message: "User key verification failed." };
    }
    const user = verification.user;
    if (user.user_id.includes("|")) return { ok: false, cancelled: false, message: "Verified user ID is invalid." };

    ctx.ui.setStatus("tdai-memory", "memory: loading teams");
    const teams = await listAll(
      (offset) => metadata.listTeams({ user_id: user.user_id, limit: PAGE_SIZE, offset }),
      "teams",
    );
    if (teams.length === 0) return { ok: false, cancelled: false, message: "No accessible Team was found for this user." };
    const team = await choose(ctx, "Select Memory Team", teams, (item) => safeLabel(item.name, item.team_id));
    if (!team) return { ok: false, cancelled: true, message: "Memory setup cancelled." };
    if (team.team_id.includes("|")) return { ok: false, cancelled: false, message: "Selected Team ID is invalid." };

    ctx.ui.setStatus("tdai-memory", "memory: loading agents");
    const agents = await listAll(
      (offset) => metadata.listAgents({ team_id: team.team_id, status: "active", limit: PAGE_SIZE, offset }),
      "agents",
    );
    const agentOptions = [CREATE_AGENT, ...agents.map((item) => safeLabel(item.name, item.agent_id))];

    let agent: SetupAgent | undefined;
    for (;;) {
      const selectedAgentOption = await ctx.ui.select("Select Memory Agent", agentOptions);
      if (!selectedAgentOption) return { ok: false, cancelled: true, message: "Memory setup cancelled." };

      if (selectedAgentOption === CREATE_AGENT) {
        const name = cleanInput(await ctx.ui.input("Name for the new private Pi agent", DEFAULT_AGENT_NAME), DEFAULT_AGENT_NAME);
        if (!name) return { ok: false, cancelled: true, message: "Memory setup cancelled." };
        if (name.length > 120) return { ok: false, cancelled: false, message: "Agent name must be at most 120 characters." };
        ctx.ui.setStatus("tdai-memory", "memory: creating Pi agent");
        createdAgent = await metadata.createAgent({
          team_id: team.team_id,
          owner_user_id: user.user_id,
          name,
          description: "Private long-term memory space for Pi.",
          visibility: "private",
          status: "active",
        });
        agent = createdAgent;
        break;
      }

      agent = agents.find((item) => safeLabel(item.name, item.agent_id) === selectedAgentOption);
      if (!agent || agent.agent_id.includes("|")) return { ok: false, cancelled: false, message: "Selected Agent is invalid." };

      // The server now auto-creates a team-visible `default-agent-<user>` on
      // cold start. Personal memory written to a non-private agent is shared
      // with the team, so warn before committing to it; declining re-prompts.
      if (agent.visibility !== "private" && ctx.ui.confirm) {
        const proceed = await ctx.ui.confirm(
          "Team-visible agent",
          `"${safeLabel(agent.name, agent.agent_id)}" is not private (${agent.visibility ?? "unknown"} visibility). Personal memory written here is shared with the team. Continue with this agent?`,
        );
        if (!proceed) continue;
      }
      break;
    }
    if (!agent) return { ok: false, cancelled: false, message: "Selected Agent is invalid." };

    ctx.ui.setStatus("tdai-memory", "memory: verifying L0-L3 access");
    const memory = (dependencies.createMemoryClient ?? defaultMemoryClient)(connection, {
      teamId: team.team_id,
      agentId: agent.agent_id,
      userId: user.user_id,
    });
    await verifyDataPlane(memory);

    const setupConfig = {
      endpoint,
      serviceId,
      teamId: team.team_id,
      agentId: agent.agent_id,
      userId: user.user_id,
      userKeyFile,
      ...(gatewayApiKeyFile ? { gatewayApiKeyFile } : {}),
    };
    const configPath = await saveGlobalSetupConfig(setupConfig, dependencies.agentDir ?? getAgentDir());
    return { ok: true, configPath, createdAgent: createdAgent !== undefined };
  } catch (error) {
    if (createdAgent) await metadata.archiveAgent(createdAgent.agent_id).catch(() => undefined);
    return { ok: false, cancelled: false, message: `Memory setup failed: ${safeError(error)}` };
  }
}
