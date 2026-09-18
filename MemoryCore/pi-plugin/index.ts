/**
 * @tencentdb-agent-memory/pi-tdai-client — Pi coding-agent extension.
 *
 * Routes Pi through the TDAI Memory Proxy. Config is env-only (Pi's
 * ExtensionAPI has no plugin config object). The extension carries only
 * routing + the dynamic per-session x-conversation-id header; all memory
 * capability (L3/L2 injection, L0 capture, L0/L1/L2 search via curl
 * recipes) arrives server-side from the proxy. (Scope C.)
 */
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { SkillBridgeClient, syncListedSkills } from "./skill-sync.js";

export default function (pi: ExtensionAPI) {
  const proxyBase = process.env.TDAI_PROXY_URL ?? "http://127.0.0.1:8096";
  const spaceId = process.env.TDAI_SPACE_ID ?? "default";
  const agentSource = process.env.TDAI_AGENT_SOURCE ?? "pi";
  const model = process.env.TDAI_MODEL ?? "glm-5.2-vision";
  const userKey = process.env.TDAI_USER_KEY ?? "";
  const teamId = process.env.TDAI_TEAM_ID ?? "";
  const agentId = process.env.TDAI_AGENT_ID ?? "";
  const taskId = process.env.TDAI_TASK_ID ?? "";

  // Graceful degradation: if required identity env vars are missing, warn and
  // skip registration so Pi still starts. The user sees the warning at load
  // and can fix the env. (A startup extension must not throw and block Pi.)
  // NOTE: TDAI_TASK_ID is OPTIONAL — task_id is an optional business dimension
  // in the TDAI kernel (MemoryCore/src/core/store/isolation.ts), and the proxy
  // registers from team+agent alone (broad recall when task is absent).
  const required: Record<string, string> = {
    TDAI_USER_KEY: userKey,
    TDAI_TEAM_ID: teamId,
    TDAI_AGENT_ID: agentId,
  };
  const missing = Object.keys(required).filter((k) => !required[k]);
  if (missing.length > 0) {
    console.warn(
      `[pi-tdai-client] Not registering the TDAI provider: missing required env var(s): ` +
        `${missing.join(", ")}. Set TDAI_USER_KEY, TDAI_TEAM_ID, ` +
        `TDAI_AGENT_ID (see MemoryCore/pi-plugin/README.md). ` +
        `TDAI_TASK_ID is optional. ` +
        `Pi will start without the TDAI provider.`,
    );
    return;
  }

  // Only send x-task-id when explicitly set; an absent/stale task makes the
  // proxy register with broad recall (no task filter) instead of failing.
  const headers: Record<string, string> = {
    "x-team-id": teamId,
    "x-agent-id": agentId,
  };
  if (taskId) headers["x-task-id"] = taskId;

  // baseUrl MUST include /v1: the OpenAI-completions provider appends
  // /chat/completions but does NOT insert /v1. Including /v1 hits the
  // proxy's explicit /:agent/:spaceId/v1/chat/completions route.
  pi.registerProvider("tdai", {
    name: "TDAI Memory Proxy",
    baseUrl: `${proxyBase}/${agentSource}/${spaceId}/v1`,
    api: "openai-completions",
    apiKey: userKey,
    headers,
    models: [
      {
        id: model,
        name: model,
        input: ["text", "image"],
        reasoning: true,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 524288,
        maxTokens: 16384,
        thinkingLevelMap: {
          off: "none",
          minimal: "minimal",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
      },
    ],
  });

  pi.registerCommand("tdai-memory-sync-skills", {
    description: "Install mined TencentDB skills into Pi's native skills directory",
    handler: async (_args, ctx) => {
      let shouldReload = false;
      const client = new SkillBridgeClient({
        proxyBase,
        spaceId,
        userKey,
        conversationId: `pi-${ctx.sessionManager.getSessionId()}`,
      });

      try {
        ctx.ui.setStatus("tdai-memory", "syncing skills");
        const candidates = await client.list();
        if (candidates.length === 0) {
          ctx.ui.notify("No mined skills are available for this TDAI agent yet.", "info");
          return;
        }
        if (ctx.hasUI) {
          const confirmed = await ctx.ui.confirm(
            "Sync TencentDB skills?",
            `${candidates.length} mined skill(s) will be installed or updated. Hand-written skills are never overwritten.`,
          );
          if (!confirmed) return;
        }

        const results = await syncListedSkills(
          client,
          join(getAgentDir(), "skills"),
          { proxyBase, spaceId },
          candidates,
        );
        const counts = results.reduce<Record<string, number>>((all, result) => {
          all[result.status] = (all[result.status] ?? 0) + 1;
          return all;
        }, {});
        const summary = [
          counts.synced ? `${counts.synced} synced` : "",
          counts["up-to-date"] ? `${counts["up-to-date"]} already current` : "",
          counts["skipped-user-owned"] ? `${counts["skipped-user-owned"]} user-owned skipped` : "",
          counts["skipped-remote-conflict"] ? `${counts["skipped-remote-conflict"]} name conflicts skipped` : "",
          counts.failed ? `${counts.failed} failed` : "",
        ].filter(Boolean).join(", ");
        ctx.ui.notify(`TDAI skill sync: ${summary}.`, counts.failed ? "warning" : "info");
        shouldReload = Boolean(counts.synced);
      } catch (error) {
        ctx.ui.notify(
          `TDAI skill sync failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      } finally {
        ctx.ui.setStatus("tdai-memory", undefined);
      }
      // Reload is terminal: Pi invalidates this command context after it reloads.
      if (shouldReload) {
        await ctx.reload();
        return;
      }
    },
  });

  pi.on("before_provider_headers", (event: any, ctx: any) => {
    if (ctx.model?.provider !== "tdai") return;
    const sid = ctx.sessionManager.getSessionId();
    event.headers["x-conversation-id"] = `pi-${sid}`;
  });
}
