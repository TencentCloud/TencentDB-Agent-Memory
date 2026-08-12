/**
 * tz-08 Ф3 — what a host actually receives from the two tools.
 *
 * Driven through a real MCP client over an in-memory transport pair, so the
 * schemas, the tool names and the result shapes are the ones a host sees — not
 * a hand-rolled imitation of them.
 *
 * The case that matters most is the failure one: a rebuilding memory must
 * reach the host as an error with its kind intact. If it arrived as an empty
 * result, the session would conclude memory holds nothing (ТЗ R2/S4).
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createMemoryMcpServer,
  renderRegistration,
  UnknownHostError,
} from "./mcp-server.js";
import {
  parseHostId,
  resolveGatewayUrl,
  sessionKeyFor,
} from "./server-config.js";
import type { MemoryConsumer, NoteInput } from "./types.js";

/** A consumer that answers whatever the case is about, and records its input. */
function fakeConsumer(over: Partial<MemoryConsumer> = {}): MemoryConsumer & {
  notes: NoteInput[];
} {
  const notes: NoteInput[] = [];
  return {
    notes,
    search: async () => ({
      ok: true,
      results: "one memory",
      total: 1,
      strategy: "hybrid",
    }),
    note: async (input) => {
      notes.push(input);
      return {
        ok: true,
        l0Recorded: 1,
        schedulerNotified: true,
        sessionKey: "s",
      };
    },
    ...over,
  };
}

async function connect(consumer: MemoryConsumer, hostId = "claude") {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([
    createMemoryMcpServer(consumer, hostId).connect(serverSide),
    client.connect(clientSide),
  ]);
  return client;
}

describe("the MCP surface every host gets", () => {
  it("offers exactly two tools, on every host", async () => {
    const client = await connect(fakeConsumer());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "memory_note",
      "memory_search",
    ]);
  });

  it("returns the server's own result text and structured fields", async () => {
    const client = await connect(fakeConsumer());
    const r = await client.callTool({
      name: "memory_search",
      arguments: { query: "релиз", limit: 3 },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({
      results: "one memory",
      total: 1,
      strategy: "hybrid",
    });
  });

  it("hands a rebuilding memory to the host as an error carrying its kind", async () => {
    const client = await connect(
      fakeConsumer({
        search: async () => ({
          ok: false,
          kind: "gated",
          message: "memory is rebuilding its index",
        }),
      }),
    );
    const r = await client.callTool({
      name: "memory_search",
      arguments: { query: "x" },
    });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]?.text).toContain("[gated]");
  });

  it("stamps the note with the host's session, and the caller cannot forge it", async () => {
    const consumer = fakeConsumer();
    const client = await connect(consumer, "codex");
    await client.callTool({
      name: "memory_note",
      // sessionKey is deliberately not part of the tool's schema.
      arguments: { content: "заметка", session_key: "somebody-else" },
    });
    expect(consumer.notes[0]?.sessionKey).toBe("tdai-mcp-codex");
  });

  it("refuses an empty note argument before it reaches the gateway", async () => {
    const consumer = fakeConsumer();
    const client = await connect(consumer);
    const r = await client.callTool({
      name: "memory_note",
      arguments: { content: "" },
    });
    expect(r.isError).toBe(true);
    expect(consumer.notes).toEqual([]);
  });
});

describe("what the host tells the server", () => {
  it("prefers an explicit gateway URL, then the pi variable, then the port", () => {
    expect([
      resolveGatewayUrl({ TDAI_GATEWAY_URL: "http://gw:9000/" }),
      resolveGatewayUrl({ TDAI_GATEWAY: "http://pi-gw:9100" }),
      resolveGatewayUrl({ TDAI_GATEWAY_PORT: "9200" }),
      resolveGatewayUrl({}),
    ]).toEqual([
      "http://gw:9000",
      "http://pi-gw:9100",
      "http://127.0.0.1:9200",
      "http://127.0.0.1:8420",
    ]);
  });

  it("reads the host id from argv and falls back to the host that passes none", () => {
    expect([
      parseHostId(["--host", "codex"]),
      parseHostId(["--host"]),
      parseHostId(["--host", "--other"]),
      parseHostId([]),
    ]).toEqual(["codex", "pi", "pi", "pi"]);
  });

  it("keeps each host's notes in its own session", () => {
    expect([sessionKeyFor("pi"), sessionKeyFor("claude")]).toEqual([
      "tdai-mcp-pi",
      "tdai-mcp-claude",
    ]);
  });
});

describe("the registration a user pastes", () => {
  it("names the host's own file and points at the real launcher", () => {
    const claude = renderRegistration("claude", {});
    expect(claude).toContain("~/.claude.json");
    expect(claude).toContain("bin/tdai-memory-mcp.mjs");
    expect(renderRegistration("codex", {})).toContain(
      "[mcp_servers.tdai-memory]",
    );
    expect(renderRegistration("pi", {})).toContain("~/.pi/agent/mcp.json");
  });

  it("bakes in a gateway URL only when this environment names one", () => {
    // A default install must keep following TDAI_GATEWAY_PORT instead of
    // freezing today's loopback URL into a config file.
    expect(renderRegistration("claude", {})).not.toContain("TDAI_GATEWAY_URL");
    expect(
      renderRegistration("claude", { TDAI_GATEWAY_URL: "http://gw:9000" }),
    ).toContain("http://gw:9000");
  });

  it("refuses a host it has no registration for, naming the ones it has", () => {
    expect(() => renderRegistration("emacs", {})).toThrow(UnknownHostError);
    expect(() => renderRegistration("emacs", {})).toThrow(
      /known hosts: pi, claude, codex/,
    );
  });
});
