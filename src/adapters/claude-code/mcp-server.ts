/**
 * ClaudeCodeMcpServer — MCP server adapter for Claude Code.
 *
 * Extends McpServerBase with Stop-hook queue support: the separate
 * `tdai-capture-hook` process writes captured turns to hook-queue.jsonl,
 * and this server drains that queue on each recall and every 30 seconds
 * in the background.
 *
 * Usage (in .claude/settings.json):
 *   {
 *     "mcpServers": {
 *       "tdai-memory": {
 *         "command": "tdai-claude-code-mcp",
 *         "env": { "TDAI_DATA_DIR": "~/.tdai", ... }
 *       }
 *     }
 *   }
 */

import fs from "node:fs";
import path from "node:path";
import { McpServerBase } from "../mcp-server-base.js";
import { ClaudeCodeHostAdapter } from "./host-adapter.js";
import type { McpHostAdapter } from "../mcp-server-base.js";

// ============================
// Hook queue types
// ============================

interface HookQueueEntry {
  sessionKey: string;
  userText: string;
  assistantText: string;
  ts: number;
}

// ============================
// ClaudeCodeMcpServer
// ============================

export class ClaudeCodeMcpServer extends McpServerBase {
  private drainTimer?: ReturnType<typeof setInterval>;

  protected createAdapter(): McpHostAdapter {
    return new ClaudeCodeHostAdapter({ ...this.opts, logger: this.logger });
  }

  private get hookQueuePath(): string {
    return path.join(this.opts.dataDir, "hook-queue.jsonl");
  }

  protected async onAfterInit(): Promise<void> {
    this.drainTimer = setInterval(() => {
      this.drainHookQueue().catch((err) => {
        this.logger.warn(
          `[mcp] background drain failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, 30_000);
    this.drainTimer.unref();
  }

  protected async onBeforeRecall(): Promise<void> {
    try {
      await this.drainHookQueue();
    } catch (err) {
      this.logger.warn(
        `[mcp] hook queue drain failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  protected async onBeforeShutdown(): Promise<void> {
    clearInterval(this.drainTimer);
    await this.drainHookQueue().catch(() => {});
  }

  // ============================
  // Hook queue draining
  // ============================

  /**
   * Consume all entries written by the Stop hook since the last drain.
   *
   * Atomic rename pattern: hook always appends to hook-queue.jsonl;
   * we rename it to hook-queue.processing.jsonl, process, then delete.
   * A concurrent hook write during processing starts a fresh queue file
   * that will be picked up on the next drain.
   */
  private async drainHookQueue(): Promise<void> {
    const src = this.hookQueuePath;
    if (!fs.existsSync(src)) return;

    const dst = src.replace(/\.jsonl$/, ".processing.jsonl");
    try {
      fs.renameSync(src, dst);
    } catch {
      return;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(dst, "utf8");
    } catch {
      return;
    } finally {
      try { fs.unlinkSync(dst); } catch { /* ignore */ }
    }

    const entries = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l) as HookQueueEntry; }
        catch { return null; }
      })
      .filter((e): e is HookQueueEntry => e !== null);

    if (entries.length === 0) return;

    this.logger.info(`[mcp] draining ${entries.length} queued hook capture(s)`);

    for (const entry of entries) {
      try {
        await this.core.handleTurnCommitted({
          userText: entry.userText,
          assistantText: entry.assistantText,
          messages: [
            { role: "user", content: entry.userText },
            { role: "assistant", content: entry.assistantText },
          ],
          sessionKey: entry.sessionKey,
          sessionId: entry.sessionKey,
          startedAt: entry.ts,
        });
      } catch (err) {
        this.logger.warn(
          `[mcp] hook queue entry capture failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
