/**
 * tz-08 Ф2 — where the write credential comes from.
 *
 * The gateway generates a loopback token and writes it to a file OUTSIDE the
 * memory tree (gateway/token.ts). Nothing about that path is knowable in
 * advance: it is derived from the configured data dir, which tz-07 made
 * host-neutral. So the consumer asks the gateway — `GET /memory/info` returns
 * the PATH (never the value) — and reads the file itself.
 *
 * Two rules this file exists to keep:
 *  - the path is never hardcoded (INVARIANT nogo-l0-path / tz-07);
 *  - the value is never logged, not even truncated. Every message here names
 *    the path or the reason, and stops there (INVARIANT nogo-secrets).
 */
import fsp from "node:fs/promises";
import { DEFAULT_TIMEOUT_MS } from "./types.js";

/** Just enough logger to report a failure without dragging a dependency in. */
export interface TokenLogger {
  warn(message: string): void;
}

export interface TokenReaderOptions {
  /** Gateway base URL — the only thing a host is configured with. */
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Injected so the test can read a file without touching a real disk. */
  readFile?: (path: string) => Promise<string>;
  logger?: TokenLogger;
}

/**
 * Resolves the write credential, caching it for the life of the process.
 *
 * Returns `undefined` when the credential cannot be obtained — an absent
 * credential is a legitimate state (gateway down, file not readable), and the
 * caller turns the resulting 401 into `unauthorized`. It is never silent: the
 * reason is logged, without the value.
 *
 * @param force re-discover the path and re-read the file, ignoring the cache.
 *   This is what the client does ONCE after a 401: the token file survives a
 *   gateway restart but is regenerated when lost, and a reconfigured data dir
 *   moves the file — so a stale cache is exactly the failure worth one retry.
 */
export function createWriteTokenReader(
  opts: TokenReaderOptions,
): (force?: boolean) => Promise<string | undefined> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const readFile =
    opts.readFile ?? ((path: string) => fsp.readFile(path, "utf-8"));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const warn = (message: string) =>
    opts.logger?.warn(`[memory-token] ${message}`);

  let cachedToken: string | undefined;
  let cachedPath: string | undefined;

  /** Ask the gateway where its token file is. The value never travels here. */
  async function discoverPath(): Promise<string | undefined> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/memory/info`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      warn(
        `cannot reach ${base}/memory/info: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
    if (res.status !== 200) {
      warn(`${base}/memory/info answered HTTP ${res.status}`);
      return undefined;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      warn(`${base}/memory/info answered with an unreadable body`);
      return undefined;
    }
    const tokenPath = (body as { tokenPath?: unknown } | null)?.tokenPath;
    if (typeof tokenPath !== "string" || !tokenPath) {
      warn(`${base}/memory/info returned no tokenPath`);
      return undefined;
    }
    return tokenPath;
  }

  return async function writeToken(force = false): Promise<string | undefined> {
    if (!force && cachedToken) return cachedToken;

    // On a forced refresh the PATH is re-discovered too: a gateway restarted
    // against a different data dir keeps serving, but its token now lives
    // somewhere else, and a cached path would read the old file forever.
    const path = force || !cachedPath ? await discoverPath() : cachedPath;
    if (!path) return undefined;
    cachedPath = path;

    let contents: string;
    try {
      contents = await readFile(path);
    } catch (err) {
      warn(
        `cannot read the token file ${path}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
    const token = contents.trim();
    if (!token) {
      warn(`the token file ${path} is empty`);
      return undefined;
    }
    cachedToken = token;
    return token;
  };
}
