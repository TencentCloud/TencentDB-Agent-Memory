import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { checkStatus, formatStatus } from "./status.js";
import type { ConfigResult } from "./types.js";

const STATUS_KEY = "tdai-memory";

export default function tdaiMemoryExtension(pi: ExtensionAPI): void {
  let currentConfig: ConfigResult | undefined;

  pi.registerCommand("tdai-memory-status", {
    description: "Check TencentDB Agent Memory configuration, identity, and connectivity",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus(STATUS_KEY, "memory: checking config");
      const config =
        currentConfig ??
        (await loadConfig({
          cwd: ctx.cwd,
          projectTrusted: ctx.isProjectTrusted(),
        }));
      ctx.ui.setStatus(STATUS_KEY, "memory: checking connection");
      const status = await checkStatus(config, (phase) => {
        ctx.ui.setStatus(STATUS_KEY, `memory: checking ${phase}`);
      });
      ctx.ui.setStatus(STATUS_KEY, status.summary);
      const kind = status.kind === "ready" || status.kind === "disabled" ? "info" : status.kind === "offline" ? "warning" : "error";
      ctx.ui.notify(formatStatus(status), kind);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    currentConfig = await loadConfig({
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
    });
    if (!currentConfig.ok) {
      ctx.ui.setStatus(STATUS_KEY, "memory: not configured");
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, currentConfig.config.enabled ? "memory: configured" : "memory: disabled");
  });
}
