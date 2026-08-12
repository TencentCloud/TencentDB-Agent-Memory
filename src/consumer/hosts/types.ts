/**
 * tz-08 Ф4 — how each host starts the consumer, and how it writes that down.
 *
 * A descriptor holds only what differs between hosts. Everything a session can
 * DO with memory is identical everywhere (`MemoryConsumer`), so a host that
 * cannot offer an operation is declared incompatible out loud rather than
 * quietly shipping a smaller set (ТЗ D1b).
 */

/** The name every host registers this server under. */
export const MCP_SERVER_NAME = "tdai-memory";

/** What the caller knows: where the launcher is, and where the gateway is. */
export interface HostContext {
  /** Absolute path of `bin/tdai-memory-mcp.mjs`. */
  launcherPath: string;
  /**
   * Gateway address to write into the registration, for every host alike.
   * Omitted when the caller names none, and then the server resolves the
   * gateway at run time instead of freezing today's address into a file.
   */
  gatewayUrl?: string;
}

export interface HostDescriptor {
  id: string;
  /** Human-readable location of the file the snippet goes into. */
  configPath: string;
  /** Always `node`: hosts run the prebuilt launcher, never a TS loader. */
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  /** The block a user pastes into `configPath`, in that file's own format. */
  registration(): string;
}

/**
 * Looking a host up either yields its descriptor or says why it cannot —
 * a refusal is a value, so an unknown host cannot be mistaken for a working
 * one that simply does less.
 */
export type HostLookup =
  | { ok: true; descriptor: HostDescriptor }
  | {
      ok: false;
      kind: "incompatible-host";
      message: string;
      known: readonly string[];
    };
