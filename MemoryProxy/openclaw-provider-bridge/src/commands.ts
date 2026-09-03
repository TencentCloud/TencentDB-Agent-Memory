import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { assertSafeHeaderValue } from "./config.js";
import { IdentityRegistry } from "./registry.js";

type CommandApi = Pick<OpenClawPluginApi, "registerCommand">;
type CommandContext = Parameters<Parameters<CommandApi["registerCommand"]>[0]["handler"]>[0];
const runtimeId = (value: string | undefined, label: string) => {
  if (!value?.trim()) throw new Error(`This command has no OpenClaw ${label} context.`);
  return assertSafeHeaderValue(value.trim(), label);
};
const help = () => [
  "Memory Proxy Bridge commands:",
  "- /memory-proxy status",
  "- /memory-proxy session conversation <new|conversationId>",
  "- /memory-proxy session task <taskId|none>",
  "- /memory-proxy agent set <teamId> <memoryAgentId>  (owner/admin; new sessions only)",
  "- /memory-proxy agent clear  (owner/admin)",
].join("\n");

export function registerMemoryProxyCommand(api: CommandApi, registry: IdentityRegistry): void {
  api.registerCommand({
    name: "memory-proxy", description: "Inspect or reselect Memory Proxy identity for this agent/session.", acceptsArgs: true,
    requireAuth: true, exposeSenderIsOwner: true,
    handler: async (ctx: CommandContext) => {
      try {
        const tokens = ctx.args?.trim().split(/\s+/).filter(Boolean) ?? [];
        const area = (tokens[0] ?? "status").toLowerCase();
        if (area === "help") return { text: help() };
        const agentId = runtimeId(ctx.agentId, "agentId");
        const sessionId = runtimeId(ctx.sessionId?.trim() || ctx.sessionKey?.trim(), "sessionId");
        if (area === "status") {
          const [agent, session] = await Promise.all([registry.getAgentIdentity(agentId), registry.getSession(agentId, sessionId)]);
          return { text: ["Memory Proxy Bridge status:", `- OpenClaw Agent: ${agentId}`, `- OpenClaw Session: ${sessionId}`, `- Team: ${session?.teamId ?? agent?.teamId ?? "(unmapped)"}`, `- Memory Agent: ${session?.memoryAgentId ?? agent?.memoryAgentId ?? "(unmapped)"}`, `- Conversation: ${session?.conversationId ?? "(created on first model request)"}`, `- Task: ${session?.taskId ?? "(none / Agent scope only)"}`].join("\n") };
        }
        if (area === "agent") {
          const allowed = ctx.senderIsOwner === true || (Array.isArray(ctx.gatewayClientScopes) && ctx.gatewayClientScopes.includes("operator.admin"));
          if (!allowed) return { text: "Agent-level Memory identity reselection requires owner/operator.admin." };
          if (tokens[1] === "set" && tokens[2] && tokens[3]) { const selected = await registry.setAgentIdentity(agentId, { teamId: tokens[2], memoryAgentId: tokens[3] }); return { text: `Agent mapping updated: team=${selected.teamId}, memoryAgent=${selected.memoryAgentId}. Existing sessions keep their frozen identity.` }; }
          if (tokens[1] === "clear") { await registry.clearAgentIdentity(agentId); return { text: "Agent override cleared; configured mapping will be used for new sessions." }; }
        }
        if (area === "session" && tokens[1] === "conversation" && tokens[2]) { const id = tokens[2].toLowerCase() === "new" ? IdentityRegistry.createConversationId() : tokens[2]; const selected = await registry.setConversationId(agentId, sessionId, id); return { text: `Session conversation selected: ${selected.conversationId}.` }; }
        if (area === "session" && tokens[1] === "task" && tokens[2]) { const task = ["none", "null", "-"].includes(tokens[2].toLowerCase()) ? undefined : tokens[2]; const selected = await registry.setTaskId(agentId, sessionId, task); return { text: `Session task selected: ${selected.taskId ?? "(none / Agent scope only)"}. Conversation rotated to ${selected.conversationId}.` }; }
        return { text: help() };
      } catch (error) { return { text: error instanceof Error ? error.message : String(error) }; }
    },
  });
}
