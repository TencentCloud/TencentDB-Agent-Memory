import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ProxyForgetClient,
  type ForgetCandidate,
  type ForgetClient,
  type ForgetPrepared,
} from "./forget-client.js";

interface ForgetCommandOptions {
  proxyBase: string;
  spaceId: string;
  userKey: string;
  createClient?: (conversationId: string) => ForgetClient;
}

interface ForgetCommandContext {
  hasUI: boolean;
  sessionManager: { getSessionId(): string };
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, level: "info" | "warning" | "error"): void;
    setStatus(key: string, message: string | undefined): void;
  };
}

function candidateLabel(candidate: ForgetCandidate): string {
  const kind = candidate.kind === "skill" ? "Skill" : "Memory Prompt";
  return `${kind}: ${candidate.name} (${candidate.detail})`;
}

function confirmationMessage(candidate: ForgetCandidate): string {
  const kind = candidate.kind === "skill" ? "Skill" : "Memory Prompt";
  return [
    `${kind}: ${candidate.name}`,
    candidate.detail,
    "",
    `Preview: ${candidate.preview}`,
    "",
    `Impact: ${candidate.impact}`,
    "",
    "This action cannot be undone.",
  ].join("\n");
}

async function chooseCandidate(
  candidates: ForgetCandidate[],
  ctx: ForgetCommandContext,
): Promise<ForgetCandidate | undefined> {
  if (candidates.length === 1) return candidates[0];

  const labels = candidates.map((candidate, index) => `${index + 1}. ${candidateLabel(candidate)}`);
  const selected = await ctx.ui.select("Select one memory item to forget", labels);
  if (!selected) return undefined;
  return candidates[labels.indexOf(selected)];
}

function assertPrepared(value: unknown): ForgetPrepared {
  if (!value || typeof value !== "object") throw new Error("memory forget response was malformed");
  const result = value as Partial<ForgetPrepared>;
  if (result.state !== "pending" || !result.actionId || !result.candidate) {
    throw new Error("memory forget action could not be prepared");
  }
  return result as ForgetPrepared;
}

export function registerMemoryForgetCommand(pi: ExtensionAPI, options: ForgetCommandOptions): void {
  pi.registerCommand("tdai-memory-forget", {
    description: "Preview and selectively delete a TencentDB Memory Prompt or Skill",
    handler: async (args, rawContext) => {
      const ctx = rawContext as ForgetCommandContext;
      const keyword = args.trim();
      if (!keyword) {
        ctx.ui.notify("Usage: /tdai-memory-forget <keyword>", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("Memory deletion requires Pi's interactive UI for explicit confirmation.", "warning");
        return;
      }

      const conversationId = `pi-${ctx.sessionManager.getSessionId()}`;
      const client = options.createClient?.(conversationId) ?? new ProxyForgetClient({
        proxyBase: options.proxyBase,
        spaceId: options.spaceId,
        userKey: options.userKey,
        conversationId,
      });

      try {
        ctx.ui.setStatus("tdai-memory", "finding items to forget");
        const discovery = await client.preview(keyword);
        if (discovery.state !== "select") {
          throw new Error("memory forget discovery response was malformed");
        }
        if (discovery.candidates.length === 0) {
          ctx.ui.notify(`No deletable Memory Prompt or Skill matched "${keyword}".`, "info");
          return;
        }

        const selected = await chooseCandidate(discovery.candidates, ctx);
        if (!selected) {
          ctx.ui.notify("Memory deletion cancelled. Nothing was changed.", "info");
          return;
        }

        const prepared = assertPrepared(await client.preview(keyword, selected.key));
        const confirmed = await ctx.ui.confirm(
          `Delete ${prepared.candidate.name}?`,
          confirmationMessage(prepared.candidate),
        );
        if (!confirmed) {
          await client.cancel(prepared.actionId);
          ctx.ui.notify("Memory deletion cancelled. Nothing was changed.", "info");
          return;
        }

        ctx.ui.setStatus("tdai-memory", "deleting selected item");
        const result = await client.confirm(prepared.actionId);
        const prefix = result.alreadyCompleted ? "Already deleted" : "Deleted";
        ctx.ui.notify(`${prefix} ${candidateLabel({ ...prepared.candidate, ...result.candidate })}.`, "info");
      } catch (error) {
        ctx.ui.notify(
          `Memory deletion failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      } finally {
        ctx.ui.setStatus("tdai-memory", undefined);
      }
    },
  });
}
