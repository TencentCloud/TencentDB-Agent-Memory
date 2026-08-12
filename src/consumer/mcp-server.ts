/**
 * tz-08 Ф3 — the one stdio-MCP server every host runs.
 *
 * Hosts differ in how they REGISTER this process (an extension entry, a JSON
 * `mcpServers` block, a TOML `mcp_servers` block) and in nothing else: the two
 * tools, their arguments and their answers are the same everywhere, because
 * they are `MemoryConsumer` verbatim (ТЗ D1a/D1b).
 *
 * Failures arrive as values with a `kind`, not as "не получилось": a host that
 * cannot tell "memory is rebuilding" from "memory is empty" will write down
 * what it already knows, which is how duplicates are born (ТЗ R2/S4).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createMemoryConsumer } from "./client.js";
import {
  describeHost,
  KNOWN_HOSTS,
  resolveLauncherPath,
} from "./hosts/registry.js";
import { createWriteTokenReader } from "./token.js";
import {
  parseHostId,
  resolveGatewayAddress,
  resolveGatewayUrl,
  sessionKeyFor,
} from "./server-config.js";
import type { ConsumerFailure, MemoryConsumer } from "./types.js";

/** stdout belongs to the JSON-RPC stream — diagnostics go to stderr only. */
const logger = {
  warn: (message: string) => void process.stderr.write(`${message}\n`),
};

/** A failure a host can act on: the kind survives, the reason is readable. */
function failed(failure: ConsumerFailure) {
  return {
    isError: true as const,
    content: [
      { type: "text" as const, text: `[${failure.kind}] ${failure.message}` },
    ],
  };
}

export function createMemoryMcpServer(
  consumer: MemoryConsumer,
  hostId: string,
): McpServer {
  const server = new McpServer({ name: "tdai-memory", version: "1.0.0" });

  server.registerTool(
    "memory_search",
    {
      title: "Search memory",
      description:
        "Search the TDAI memory of past sessions. Returns the rendered result " +
        "the memory gateway produced. An unavailable or rebuilding memory is " +
        "reported as such — it is never an empty result.",
      inputSchema: {
        query: z.string().min(1).describe("What to look for"),
        limit: z
          .number()
          .int()
          .optional()
          .describe("Max results (server clamps to 1..50, default 5)"),
        type: z.string().optional().describe("Restrict to a memory type"),
        scene: z.string().optional().describe("Restrict to a scene"),
      },
      outputSchema: {
        results: z.string(),
        total: z.number(),
        strategy: z.string(),
      },
    },
    async (args) => {
      const r = await consumer.search(args);
      if (!r.ok) return failed(r);
      return {
        content: [
          {
            type: "text" as const,
            text: r.results || "(memory holds nothing for this query)",
          },
        ],
        structuredContent: {
          results: r.results,
          total: r.total,
          strategy: r.strategy,
        },
      };
    },
  );

  server.registerTool(
    "memory_note",
    {
      title: "Write a note to memory",
      description:
        "Record a note in TDAI memory. The note is written through the " +
        "gateway's write gate and becomes searchable once extraction runs.",
      inputSchema: {
        content: z.string().min(1).describe("The note text"),
        project_id: z
          .string()
          .optional()
          .describe("Project this note belongs to"),
      },
      outputSchema: {
        l0_recorded: z.number(),
        scheduler_notified: z.boolean(),
        session_key: z.string(),
      },
    },
    async (args) => {
      // The session carries the host id, so a note stays attributable to the
      // host that wrote it. The caller does not get to forge it.
      const r = await consumer.note({
        content: args.content,
        sessionKey: sessionKeyFor(hostId),
        ...(args.project_id ? { projectId: args.project_id } : {}),
      });
      if (!r.ok) return failed(r);
      return {
        content: [
          {
            type: "text" as const,
            text: `noted (${r.l0Recorded} message(s) recorded in session ${r.sessionKey})`,
          },
        ],
        structuredContent: {
          l0_recorded: r.l0Recorded,
          scheduler_notified: r.schedulerNotified,
          session_key: r.sessionKey,
        },
      };
    },
  );

  return server;
}

/** Raised when a host cannot be registered — input, so it is reported, not thrown at. */
export class UnknownHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownHostError";
  }
}

/**
 * The block a user pastes into their host's config, and where it goes.
 *
 * The gateway URL is baked in only when the address would not survive the
 * paste — see below. A default local install gets a snippet without one, so it
 * keeps resolving the gateway at run time instead of freezing today's address
 * into a config file.
 *
 * @throws UnknownHostError when the host has no registration in this build.
 */
export function renderRegistration(
  hostId: string,
  env: NodeJS.ProcessEnv,
  argv: readonly string[] = [],
): string {
  // A host starts this server from its own config file, not from the shell
  // that printed the snippet — another directory, another environment. So an
  // address only THIS shell can resolve (a flag, TDAI_GATEWAY_URL or _PORT, a
  // config named by TDAI_GATEWAY_CONFIG, a tdai-gateway.yaml in the current
  // directory) has to travel INSIDE the snippet, or the pasted line serves a
  // gateway the user never named — on a machine running a default one too,
  // another memory answers and the next note lands in it. What the MACHINE
  // answers — the data dir's own config, or the default — is left out, so a
  // later change of port is picked up instead of frozen into a config file.
  const address = resolveGatewayAddress(env, argv);
  const lookup = describeHost(hostId, {
    launcherPath: resolveLauncherPath(),
    ...(address.isPortable ? {} : { gatewayUrl: address.url }),
  });
  if (!lookup.ok) throw new UnknownHostError(lookup.message);
  const { descriptor } = lookup;
  return [
    `# ${descriptor.id}: add this to ${descriptor.configPath}`,
    descriptor.registration(),
    "",
  ].join("\n");
}

/** Wire the server to this process's stdio and serve until the host closes it. */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const baseUrl = resolveGatewayUrl(env, argv);
  const hostId = parseHostId(argv);

  // Setup, not serving: stdout is still free, and the process must not go on
  // to speak JSON-RPC at a terminal the user is reading.
  if (argv.includes("--print-registration")) {
    process.stdout.write(renderRegistration(hostId, env, argv));
    return;
  }
  // An id this build has no registration for still serves — the tools do not
  // depend on it — but it is said out loud, because it also names the session
  // the host's notes are recorded under and a typo would silently split them.
  if (!KNOWN_HOSTS.includes(hostId)) {
    logger.warn(
      `[tdai-memory-mcp] unknown host "${hostId}" — known hosts: ${KNOWN_HOSTS.join(", ")}; ` +
        `notes will be recorded under session ${sessionKeyFor(hostId)}`,
    );
  }

  const consumer = createMemoryConsumer({
    baseUrl,
    writeToken: createWriteTokenReader({ baseUrl, logger }),
  });
  await createMemoryMcpServer(consumer, hostId).connect(
    new StdioServerTransport(),
  );
  logger.warn(`[tdai-memory-mcp] serving host=${hostId} gateway=${baseUrl}`);
}

// Direct execution — the documented dev path, `npx tsx src/consumer/mcp-server.ts`.
// The packaged path does not rely on this: `bin/tdai-memory-mcp.mjs` imports
// `main` and calls it, so the entry point holds no logic of its own.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2), process.env).catch((err: unknown) => {
    process.stderr.write(
      `[tdai-memory-mcp] failed to start: ${err instanceof Error ? err.stack : String(err)}\n`,
    );
    process.exit(1);
  });
}
