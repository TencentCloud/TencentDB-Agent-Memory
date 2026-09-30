/**
 * McpHostAdapterBase — HostAdapter for MCP/stdio platforms.
 *
 * An MCP server is one session per process, so the default session key is
 * resolved once from the platform's own environment variable. That resolution
 * is the only thing MCP adapters add over HostAdapterBase.
 *
 * Subclasses (ClaudeCodeHostAdapter, CursorHostAdapter, CodexHostAdapter)
 * provide:
 *   hostType          — platform identifier for TdaiCore routing
 *   platformId        — platform label written into RuntimeContext
 *   resolveSessionKey — the env var strategy for this platform
 */

import { randomUUID } from "node:crypto";
import { HostAdapterBase } from "./host-adapter-base.js";
import type { HostAdapterBaseOptions } from "./host-adapter-base.js";

export type { StandaloneLLMConfig } from "./host-adapter-base.js";

// ============================
// Options
// ============================

export interface McpHostAdapterOptions extends HostAdapterBaseOptions {
  /**
   * Session key to use when a per-request key is not provided.
   * If omitted, falls back to the platform's session env var,
   * then to a process-scoped UUID.
   */
  defaultSessionKey?: string;
}

// ============================
// McpHostAdapterBase
// ============================

export abstract class McpHostAdapterBase extends HostAdapterBase {
  /**
   * Derive the default session key for this platform.
   * Receives the explicit option (may be undefined).
   * Typical fallback chain: explicit → env var → randomUUID().
   */
  protected abstract resolveSessionKey(explicit: string | undefined): string;

  private readonly explicitSessionKey: string | undefined;
  private _defaultSessionKey?: string;

  constructor(opts: McpHostAdapterOptions) {
    super(opts);
    this.explicitSessionKey = opts.defaultSessionKey;
  }

  /**
   * Resolved once on first use rather than in the constructor, so that a
   * subclass `resolveSessionKey` may safely read its own instance fields.
   */
  getDefaultSessionKey(): string {
    this._defaultSessionKey ??= this.resolveSessionKey(this.explicitSessionKey);
    return this._defaultSessionKey;
  }

  protected override contextSessionKey(): string {
    return this.getDefaultSessionKey();
  }
}

// ============================
// Shared session key helpers
// ============================

/** Fall back to env var then a new UUID. */
export function sessionKeyFromEnv(
  explicit: string | undefined,
  envVar: string,
): string {
  return explicit ?? process.env[envVar] ?? randomUUID();
}
