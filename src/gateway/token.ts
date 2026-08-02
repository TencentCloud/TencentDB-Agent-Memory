/**
 * Loopback memory token management (wave tdai-memory-subagents-2026-08-02).
 *
 * Write routes that mutate memory (`/memory/apply`, `/memory/run`, later
 * `/memory/feedback`, `/memory/note`) are protected by a per-gateway loopback
 * token in ADDITION to (or, when no apiKey is configured, instead of) the
 * `Authorization: Bearer` gate — see write-auth.ts.
 *
 * Token lifecycle:
 * - Generated on first gateway startup (`randomBytes(32).toString("hex")`).
 * - Persisted at `<dataDir>/../tdai-gateway.token` — OUTSIDE the memory tree
 *   (a sibling of the data dir) with mode 0600.
 * - Reused across restarts: the pi extension caches nothing and re-reads the
 *   file on every call (and on 401), so a stable file avoids churn.
 *
 * Security notes (INVARIANT nogo-secrets):
 * - The token is never logged and never exposed through any route — discovery
 *   (`GET /memory/info`) returns only the token file PATH, not its contents.
 * - The file lives outside the memory tree so a memory-export/backup of the
 *   data dir cannot accidentally carry the credential.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../core/types.js";

export const LOOPBACK_TOKEN_FILENAME = "tdai-gateway.token";

export class LoopbackTokenManager {
  private readonly dataDir: string;
  private readonly logger: Logger;
  private readonly tokenFilePath: string;
  private token: string | null = null;

  constructor(dataDir: string, logger: Logger) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.tokenFilePath = path.join(path.dirname(path.resolve(dataDir)), LOOPBACK_TOKEN_FILENAME);
  }

  /** Absolute path of the token file (sibling of dataDir). */
  get tokenPath(): string {
    return this.tokenFilePath;
  }

  /**
   * Load-or-generate the loopback token and ensure the 0600 token file exists.
   * Idempotent — safe to call on every write-gate evaluation.
   */
  ensure(): string {
    if (this.token) return this.token;

    // Reuse an existing token file across restarts (stable credential for the
    // pi extension). A malformed/empty file is treated as absent.
    try {
      const existing = fs.readFileSync(this.tokenFilePath, "utf-8").trim();
      if (existing) {
        this.token = existing;
        return this.token;
      }
    } catch {
      // No file yet — first start.
    }

    this.token = crypto.randomBytes(32).toString("hex");
    try {
      fs.mkdirSync(path.dirname(this.tokenFilePath), { recursive: true });
      // writeFileSync mode is umask-masked — chmod afterwards guarantees 0600.
      fs.writeFileSync(this.tokenFilePath, `${this.token}\n`, { mode: 0o600 });
      fs.chmodSync(this.tokenFilePath, 0o600);
    } catch (err) {
      // Fail-open for the file write: the in-memory token still protects this
      // process; only cross-process delivery (pi extension) is lost. Log it.
      this.logger.warn(
        `[memory-token] Failed to write token file ${this.tokenFilePath}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.logger.debug?.(`[memory-token] Loopback token ready at ${this.tokenFilePath}`);
    return this.token;
  }
}
