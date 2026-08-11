/**
 * tz-08 — the one consumer implementation. Every host runs THIS.
 *
 * Transport, and nothing else: build the URL or the body, carry the right
 * header, read the answer back. No ranking, no dedup, no truncation, no
 * caching, no retry policy — the moment any of those appear here, the answer
 * a host sees stops following the server, and that is exactly the second copy
 * of server logic the package exists to prevent (ТЗ D1a/R1).
 *
 * The single exception is written down where it happens: ONE re-read of the
 * credential after a 401 (see `note`).
 */
import {
  DEFAULT_TIMEOUT_MS,
  type ConsumerResult,
  type MemoryConsumer,
  type NoteInput,
  type NoteOk,
  type SearchInput,
  type SearchOk,
} from "./types.js";

export interface ClientOptions {
  /** Gateway base URL, e.g. `http://127.0.0.1:8420`. */
  baseUrl: string;
  /**
   * Supplies the write credential. Called only for writes — a read must not
   * carry a token it does not need (ТЗ D1c). `force` asks for a fresh read
   * from disk instead of the cached value.
   */
  writeToken(force?: boolean): Promise<string | undefined>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** HTTP status → failure kind. The mapping is the whole error model. */
function kindOf(
  status: number,
): "unauthorized" | "bad-request" | "server-error" {
  if (status === 401 || status === 403) return "unauthorized";
  if (status >= 400 && status < 500) return "bad-request";
  return "server-error";
}

export function createMemoryConsumer(opts: ClientOptions): MemoryConsumer {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = opts.baseUrl.replace(/\/+$/, "");

  /** One HTTP round trip. Never throws: transport faults become values. */
  async function call(
    path: string,
    init: RequestInit,
  ): Promise<
    | { ok: true; status: number; body: unknown }
    | { ok: false; kind: "unavailable"; message: string }
  > {
    try {
      const res = await fetchImpl(`${base}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      let body: unknown = undefined;
      try {
        body = await res.json();
      } catch {
        // Keep undefined — `status` still decides, and a 200 with a broken
        // body is a server error, not an empty answer.
      }
      return { ok: true, status: res.status, body };
    } catch (err) {
      return {
        ok: false,
        kind: "unavailable",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    async search(input: SearchInput): Promise<ConsumerResult<SearchOk>> {
      const params = new URLSearchParams({ query: input.query });
      // `limit` travels as the caller gave it: the server clamps to 1..50.
      if (input.limit !== undefined) params.set("limit", String(input.limit));
      if (input.type) params.set("type", input.type);
      if (input.scene) params.set("scene", input.scene);

      // No credential on the read path — the route is auth-free loopback, and
      // carrying a secret where it is not required is how secrets leak.
      const r = await call(`/memory/search?${params.toString()}`, {
        method: "GET",
      });
      if (!r.ok) {
        return {
          ok: false,
          kind: "unavailable",
          message: `memory gateway unreachable: ${r.message}`,
        };
      }
      if (r.status !== 200) {
        return {
          ok: false,
          kind: kindOf(r.status),
          message: errorText(r.body, `search failed with HTTP ${r.status}`),
        };
      }
      const body = r.body as Partial<SearchOk> & { gated?: boolean };
      if (body?.gated === true) {
        return {
          ok: false,
          kind: "gated",
          message:
            "memory is rebuilding its index — this is not an empty memory",
        };
      }
      if (typeof body?.results !== "string") {
        return {
          ok: false,
          kind: "server-error",
          message: "search answered with an unreadable body",
        };
      }
      return {
        ok: true,
        results: body.results,
        total: typeof body.total === "number" ? body.total : 0,
        strategy: typeof body.strategy === "string" ? body.strategy : "unknown",
      };
    },

    async note(input: NoteInput): Promise<ConsumerResult<NoteOk>> {
      const send = async (token: string | undefined) =>
        await call("/memory/note", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { "x-memory-token": token } : {}),
          },
          body: JSON.stringify({
            content: input.content,
            ...(input.sessionKey ? { session_key: input.sessionKey } : {}),
            ...(input.projectId ? { project_id: input.projectId } : {}),
          }),
        });

      let r = await send(await opts.writeToken());
      // The ONLY repeat in this file, and only for a credential: the token
      // file survives restarts but is regenerated when lost, so a stale cached
      // value is the one 401 worth a second attempt. Timeouts, 5xx and
      // unreachability are NOT retried — a transport that retries silently
      // turns one user action into several writes.
      if (r.ok && (r.status === 401 || r.status === 403)) {
        const fresh = await opts.writeToken(true);
        if (fresh) r = await send(fresh);
      }

      if (!r.ok) {
        return {
          ok: false,
          kind: "unavailable",
          message: `memory gateway unreachable: ${r.message}`,
        };
      }
      if (r.status !== 200) {
        return {
          ok: false,
          kind: kindOf(r.status),
          message: errorText(r.body, `note failed with HTTP ${r.status}`),
        };
      }
      const body = r.body as {
        l0_recorded?: number;
        scheduler_notified?: boolean;
        session_key?: string;
      };
      return {
        ok: true,
        l0Recorded:
          typeof body?.l0_recorded === "number" ? body.l0_recorded : 0,
        schedulerNotified: body?.scheduler_notified === true,
        sessionKey:
          typeof body?.session_key === "string" ? body.session_key : "",
      };
    },
  };
}

/** The server's own error text when it sent one; otherwise the fallback. */
function errorText(body: unknown, fallback: string): string {
  const error = (body as { error?: unknown } | undefined)?.error;
  return typeof error === "string" && error ? error : fallback;
}
